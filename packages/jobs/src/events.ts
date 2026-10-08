import { db } from "@console/db";
import { type Job, type JobKind, job } from "@console/db/schema";
import type { GitEvent, GitStore, ProjectRepo } from "@console/git";
import { and, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { changed, HELD_STATUSES, reportAll } from "./queue";

type Wire<T> = T extends { at: Date } ? Omit<T, "at"> & { at: string } : T;
export type WireGitEvent = Wire<GitEvent>;

export function toWire(event: GitEvent): WireGitEvent {
  return "at" in event ? { ...event, at: event.at.toISOString() } : event;
}

export interface GitEventPayload {
  deliveryId: string;
  appId: string;
  event: WireGitEvent;
}

export interface GitEventDeps {
  store: Pick<GitStore, "findInstallation" | "projectsForRepo">;
  notify: (changed: Job) => Promise<void>;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RepoEvent = Exclude<WireGitEvent, { type: "uninstalled" }>;

interface Wanted {
  kind: JobKind;
  pr: number;
  sha?: string;
  branch?: string;
}

function wanted(event: RepoEvent, project: ProjectRepo): Wanted | undefined {
  switch (event.type) {
    case "push":
      if (event.deleted || event.branch !== project.productionBranch) return undefined;
      return { kind: "deploy", pr: 0, sha: event.sha, branch: event.branch };
    case "pr_opened":
    case "pr_sync":
      if (event.fork) return undefined;
      return { kind: "preview-up", pr: event.pr, sha: event.sha, branch: event.branch };
    case "pr_closed":
      return { kind: "preview-rm", pr: event.pr };
  }
}

async function previewOf(tx: Tx, projectId: string, pr: number) {
  const [preview] = await tx
    .select({ ran: isNotNull(job.claimedAt) })
    .from(job)
    .where(and(eq(job.projectId, projectId), eq(job.pr, pr), eq(job.kind, "preview-up")))
    .orderBy(desc(isNotNull(job.claimedAt)))
    .limit(1);
  return preview;
}

async function supersede(tx: Tx, projectId: string, pr: number): Promise<Job[]> {
  const here = and(eq(job.projectId, projectId), eq(job.pr, pr));
  return [
    ...(await tx
      .update(job)
      .set({ status: "canceled", finishedAt: sql`now()`, ...changed() })
      .where(and(here, eq(job.status, "queued")))
      .returning()),
    ...(await tx
      .update(job)
      .set({ cancelRequested: true, ...changed() })
      .where(and(here, inArray(job.status, HELD_STATUSES), eq(job.cancelRequested, false)))
      .returning()),
  ];
}

async function outdated(tx: Tx, event: RepoEvent, eventAt: Date, projectId: string, pr: number) {
  const [latest] = await tx
    .select({ kind: job.kind, eventAt: job.eventAt })
    .from(job)
    .where(and(eq(job.projectId, projectId), eq(job.pr, pr)))
    .orderBy(desc(job.eventAt), desc(job.createdAt))
    .limit(1);
  if (!latest) return false;
  if (latest.eventAt > eventAt) return true;
  const reopened = event.type === "pr_opened" && event.reopened;
  return latest.kind === "preview-rm" && event.type !== "pr_closed" && !reopened;
}

async function enqueueFor(
  tx: Tx,
  deliveryId: string,
  event: RepoEvent,
  project: ProjectRepo,
): Promise<Job[]> {
  const want = wanted(event, project);
  if (!want) return [];

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${project.id}))`);
  const [seen] = await tx
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.projectId, project.id), eq(job.dedupeKey, deliveryId)));
  if (seen) return [];

  const eventAt = new Date(event.at);
  if (await outdated(tx, event, eventAt, project.id, want.pr)) return [];

  const insert = (over: { status?: "done"; finishedAt?: SQL } = {}) =>
    tx
      .insert(job)
      .values({
        id: crypto.randomUUID(),
        projectId: project.id,
        kind: want.kind,
        pr: want.pr,
        sha: want.sha ?? null,
        branch: want.branch ?? null,
        labels: project.jobLabels,
        dedupeKey: deliveryId,
        eventAt,
        ...over,
      })
      .returning();

  // A deploy runs to the end: a newer push queues behind it instead of replacing it.
  if (want.kind === "deploy") return insert();

  const preview = want.kind === "preview-rm" ? await previewOf(tx, project.id, want.pr) : undefined;
  const superseded = await supersede(tx, project.id, want.pr);
  if (want.kind === "preview-up" || preview?.ran) return [...superseded, ...(await insert())];

  // A close is recorded even with nothing to remove, so an update arriving after it is refused.
  const closed = await insert({ status: "done", finishedAt: sql`now()` });
  return preview ? [...superseded, ...closed] : superseded;
}

export async function handleGitEvent(payload: GitEventPayload, deps: GitEventDeps): Promise<void> {
  const { deliveryId, event } = payload;
  if (event.type === "uninstalled") return;

  const installation = await deps.store.findInstallation(payload.appId, event.installation);
  if (!installation) return;
  const projects = await deps.store.projectsForRepo(installation.id, event.repo.id);
  if (projects.length === 0) return;

  const changes = await db.transaction(async (tx) => {
    const made: Job[] = [];
    for (const project of projects)
      made.push(...(await enqueueFor(tx, deliveryId, event, project)));
    return made;
  });
  await reportAll(changes, deps.notify);
}
