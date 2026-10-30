import { db, type Executor, type Transaction } from "@console/db";
import { type Job, type JobKind, type JobSpec, job } from "@console/db/schema";
import type { GitEvent, GitStore, InstallationRef, ProjectRepo, RepoRef } from "@console/git";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { runnerIdOf } from "./bindings";
import { announce } from "./changes";
import { type JobDeps, nowOf } from "./deps";
import { recordDispatch } from "./dispatch";
import { placeJob, statedNaming } from "./place";
import { type ConfiguredProvider, configuredProvider } from "./project-config";
import { sendJob } from "./send";
import { isFromGit, isFromRepository, isHeld } from "./state";
import { followCancels, stopJobs } from "./stop";

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

export type RepoFileReader = (
  appId: string,
  installation: InstallationRef,
  repo: RepoRef,
  file: { ref: string; path: string },
) => Promise<string | undefined>;

export interface GitEventDeps extends JobDeps {
  store: Pick<GitStore, "findInstallation" | "projectsForRepo">;
  readFile: RepoFileReader;
}

type RepoEvent = Exclude<WireGitEvent, { type: "uninstalled" }>;

interface Wanted {
  kind: JobKind;
  pr: number;
  sha?: string;
  branch?: string;
}

function wanted(event: RepoEvent, project: ProjectRepo): Wanted | undefined {
  if (project.deploys === "ci") return undefined;
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

async function previewOf(tx: Executor, projectId: string, pr: number) {
  const [preview] = await tx
    .select({
      lane: job.lane,
      sha: job.sha,
      branch: job.branch,
      provider: sql<string | null>`${job.spec}->>'provider'`,
    })
    .from(job)
    .where(
      and(
        eq(job.projectId, projectId),
        eq(job.tier, "preview"),
        eq(job.pr, pr),
        eq(job.kind, "preview-up"),
        isFromRepository,
        isNotNull(job.sha),
        or(isNotNull(job.dispatchedAt), isNotNull(job.runUrl)),
      ),
    )
    .orderBy(desc(job.eventAt), desc(job.createdAt))
    .limit(1);
  return preview;
}

async function outdated(
  tx: Transaction,
  event: RepoEvent,
  eventAt: Date,
  projectId: string,
  want: Wanted,
) {
  const [latest] = await tx
    .select({ kind: job.kind, eventAt: job.eventAt })
    .from(job)
    .where(
      and(
        eq(job.projectId, projectId),
        eq(job.tier, tierOf(want)),
        eq(job.pr, want.pr),
        isFromRepository,
      ),
    )
    .orderBy(desc(job.eventAt), desc(job.createdAt))
    .limit(1);
  if (!latest) return false;
  if (latest.eventAt > eventAt) return true;
  const reopened = event.type === "pr_opened" && event.reopened;
  return latest.kind === "preview-rm" && event.type !== "pr_closed" && !reopened;
}

const tierOf = (want: Wanted) => (want.kind === "deploy" ? "production" : "preview");

const previewOfPr = (pr: number) => `pr-${pr}`;

function specOf(
  event: RepoEvent,
  want: Wanted,
  preview: string,
  sha: string,
  branch: string | null,
  provider: string | undefined,
): JobSpec {
  return {
    ...(provider === undefined ? {} : { provider }),
    source: { git: { cloneUrl: `https://github.com/${event.repo.fullName}.git`, commit: sha } },
    git: {
      commit: sha,
      ...(branch ? { branch } : {}),
      dirty: false,
      ...(want.kind === "deploy" ? {} : { pullRequest: want.pr }),
    },
    ...(want.kind === "deploy" ? {} : { preview: { name: preview, persistent: false } }),
  };
}

interface Made {
  stopped: Job[];
  made: Job[];
  dispatched: Job[];
}

const nothing = (): Made => ({ stopped: [], made: [], dispatched: [] });

function superseded(projectId: string, want: Wanted, preview: string) {
  return want.kind === "deploy"
    ? and(eq(job.projectId, projectId), eq(job.tier, "production"), isFromGit, isHeld)
    : and(eq(job.projectId, projectId), eq(job.tier, "preview"), eq(job.lane, preview));
}

async function enqueueFor(
  tx: Transaction,
  deliveryId: string,
  event: RepoEvent,
  project: ProjectRepo,
  configured: ConfiguredProvider | undefined,
  now: Date,
): Promise<Made> {
  const want = wanted(event, project);
  if (!want) return nothing();

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${project.id}))`);
  const [seen] = await tx
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.projectId, project.id), eq(job.dedupeKey, deliveryId)));
  if (seen) return nothing();

  const eventAt = new Date(event.at);
  if (await outdated(tx, event, eventAt, project.id, want)) return nothing();

  const tier = tierOf(want);
  const preview = want.kind === "preview-rm" ? await previewOf(tx, project.id, want.pr) : undefined;
  const lane = want.kind === "deploy" ? "" : preview?.lane || previewOfPr(want.pr);
  const ended = (status: "done" | "failed", error: string | null) =>
    tx
      .insert(job)
      .values({
        id: crypto.randomUUID(),
        projectId: project.id,
        kind: want.kind,
        tier,
        status,
        pr: want.pr,
        lane,
        sha: want.sha ?? null,
        branch: want.branch ?? null,
        dedupeKey: deliveryId,
        eventAt,
        error,
        finishedAt: now,
      })
      .returning();

  const stopped = await stopJobs(tx, superseded(project.id, want, lane), now);

  // A close is recorded even with nothing to remove, so an update arriving after it is refused.
  if (want.kind === "preview-rm" && !preview) {
    const closed = await ended("done", null);
    return { stopped, made: stopped.length > 0 ? closed : [], dispatched: [] };
  }

  const sha = want.sha ?? preview?.sha ?? null;
  const branch = want.branch ?? preview?.branch ?? null;
  if (!sha || !configured) {
    return { stopped, made: await ended("failed", "The commit to run is unknown"), dispatched: [] };
  }
  if (configured.ok && configured.slug !== undefined && configured.slug !== project.slug) {
    const why = `The project's config at this commit names slug ${configured.slug}, but the repository is linked to project ${project.slug}: change the config's slug, or link the repository to project ${configured.slug}`;
    return { stopped, made: await ended("failed", why), dispatched: [] };
  }
  const placed = await placeJob({
    projectId: project.id,
    tier,
    kind: want.kind,
    naming: configured.ok ? statedNaming(configured.provider) : "unknown",
  });
  if (!placed.ok) {
    const why = configured.ok ? placed.message : `${placed.message} (${configured.message})`;
    return { stopped, made: await ended("failed", why), dispatched: [] };
  }

  const { job: made } = await recordDispatch(tx, {
    projectId: project.id,
    tier,
    kind: want.kind,
    requestId: deliveryId,
    runnerId: runnerIdOf(placed.runner),
    spec: specOf(event, want, lane, sha, branch, configured.ok ? configured.provider : undefined),
    pr: want.pr,
    sha,
    branch,
    eventAt,
    trigger: { kind: "git" },
  });
  return { stopped, made: [made], dispatched: [made] };
}

export async function handleGitEvent(payload: GitEventPayload, deps: GitEventDeps): Promise<void> {
  const { deliveryId, event } = payload;
  if (event.type === "uninstalled") return;

  const installation = await deps.store.findInstallation(payload.appId, event.installation);
  if (!installation) return;
  const projects = await deps.store.projectsForRepo(installation.id, event.repo.id);
  if (projects.length === 0) return;

  const configured = new Map<string, ConfiguredProvider>();
  for (const project of projects) {
    const want = wanted(event, project);
    if (!want) continue;
    const preview =
      want.kind === "preview-rm" ? await previewOf(db, project.id, want.pr) : undefined;
    if (typeof preview?.provider === "string") {
      configured.set(project.id, { ok: true, provider: preview.provider });
      continue;
    }
    const ref = want.sha ?? preview?.sha;
    if (!ref) continue;
    configured.set(
      project.id,
      await configuredProvider(
        (path) => deps.readFile(payload.appId, installation, event.repo, { ref, path }),
        "",
      ),
    );
  }

  const now = nowOf(deps);
  const all = await db.transaction(async (tx) => {
    const made = nothing();
    for (const project of projects) {
      const one = await enqueueFor(tx, deliveryId, event, project, configured.get(project.id), now);
      made.stopped.push(...one.stopped);
      made.made.push(...one.made);
      made.dispatched.push(...one.dispatched);
    }
    return made;
  });
  await followCancels(all.stopped, deps);
  await announce(all.made, deps.notify);
  for (const row of all.dispatched) await sendJob(row.id, deps);
}
