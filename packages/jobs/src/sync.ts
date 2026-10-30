import { consoleOrigin } from "@console/auth/origin";
import { db } from "@console/db";
import {
  deployment,
  gitInstallation,
  type Job,
  job,
  project,
  projectRepo,
} from "@console/db/schema";
import type { CommitState, DeploymentState, GitRuntime } from "@console/git";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { markSynced } from "./changes";
import {
  PREVIEW_MARKER,
  type PreviewDeployment,
  type PreviewRow,
  renderPreviewComment,
} from "./render";
import { isFromRepository } from "./state";

export type SyncDeps = Pick<GitRuntime, "providerFor"> & {
  store: Pick<GitRuntime["store"], "loadApp">;
};

const COMMIT_STATES: Record<Job["status"], CommitState> = {
  queued: "pending",
  running: "pending",
  "input-required": "pending",
  done: "success",
  failed: "failure",
  canceled: "error",
};

const DEPLOYMENT_STATES: Record<Job["status"], DeploymentState> = {
  queued: "queued",
  running: "in_progress",
  "input-required": "in_progress",
  done: "success",
  failed: "failure",
  canceled: "inactive",
};

const DESCRIPTION_LIMIT = 140;

const DESCRIPTIONS: Record<Job["status"], string> = {
  queued: "Queued",
  running: "Running",
  "input-required": "Waiting for an answer in the console",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

export function describedOf(row: Pick<Job, "status" | "error">): string {
  const said = row.status === "failed" && row.error ? row.error : DESCRIPTIONS[row.status];
  const line = said.split("\n")[0] ?? said;
  return line.length <= DESCRIPTION_LIMIT ? line : `${line.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

export interface ConsolePlace {
  origin: string;
  organizationId: string;
  slug: string;
}

export function linkOf(
  row: Pick<Job, "id" | "runUrl" | "deploymentId" | "runnerId">,
  place: ConsolePlace,
): { href: string; label: string } {
  if (row.runUrl) return { href: row.runUrl, label: "Run log" };
  const base = `${place.origin}/projects/${encodeURIComponent(place.slug)}`;
  const page = row.deploymentId
    ? `/deployments/${row.deploymentId}`
    : row.runnerId
      ? `/jobs/${row.id}`
      : "/targets";
  return {
    href: `${base}${page}?org=${encodeURIComponent(place.organizationId)}`,
    label: "Open in the console",
  };
}

export const previewEnvironment = (pr: number, slug: string) => `preview/pr-${pr}/${slug}`;

async function deploymentOf(
  projectId: string,
  deploymentId: string | null,
): Promise<PreviewDeployment | undefined> {
  if (!deploymentId) return undefined;
  const [found] = await db
    .select({
      provider: deployment.providerName,
      finishedAt: deployment.deployedAt,
      topology: deployment.topology,
    })
    .from(deployment)
    .where(and(eq(deployment.projectId, projectId), eq(deployment.deploymentId, deploymentId)));
  if (!found?.finishedAt) return undefined;
  return {
    provider: found.provider,
    finishedAt: found.finishedAt,
    apps: found.topology.apps.map((app) => ({ name: app.name, url: app.urls[0] })),
  };
}

const urlOf = (deployed: PreviewDeployment | undefined) =>
  deployed?.apps.find((app) => app.url)?.url;

async function latestPreviews(
  installationId: string,
  repoId: string,
  pr: number,
): Promise<PreviewRow[]> {
  const linked = await db
    .select({
      id: project.id,
      name: project.name,
      slug: project.slug,
      organizationId: project.organizationId,
    })
    .from(projectRepo)
    .innerJoin(project, eq(project.id, projectRepo.projectId))
    .where(and(eq(projectRepo.installationId, installationId), eq(projectRepo.repoId, repoId)))
    .orderBy(project.name);

  const rows: PreviewRow[] = [];
  for (const linkedProject of linked) {
    const [latest] = await db
      .select()
      .from(job)
      .where(
        and(
          eq(job.projectId, linkedProject.id),
          eq(job.pr, pr),
          inArray(job.kind, ["preview-up", "preview-rm"]),
          isFromRepository,
          ne(job.status, "canceled"),
        ),
      )
      .orderBy(desc(job.eventAt), desc(job.createdAt))
      .limit(1);
    if (!latest) continue;
    rows.push({
      project: linkedProject.name,
      job: latest,
      deployment: await deploymentOf(linkedProject.id, latest.deploymentId),
      link: linkOf(latest, { ...linkedProject, origin: consoleOrigin() }),
    });
  }
  return rows;
}

const GIT_KINDS = new Set<Job["kind"]>(["deploy", "preview-up", "preview-rm"]);

const fromGit = (synced: Job) =>
  GIT_KINDS.has(synced.kind) && !(synced.spec && "sourceId" in synced.spec.source);

async function report(synced: Job, deps: SyncDeps): Promise<void> {
  if (!fromGit(synced)) return;
  const [found] = await db
    .select({
      slug: project.slug,
      organizationId: project.organizationId,
      repoId: projectRepo.repoId,
      fullName: projectRepo.fullName,
      installationId: gitInstallation.id,
      externalId: gitInstallation.externalId,
      gitAppId: gitInstallation.gitAppId,
    })
    .from(project)
    .innerJoin(projectRepo, eq(projectRepo.projectId, project.id))
    .innerJoin(gitInstallation, eq(gitInstallation.id, projectRepo.installationId))
    .where(eq(project.id, synced.projectId));
  if (!found) return;

  const app = await deps.store.loadApp(found.gitAppId);
  if (!app) return;
  const provider = deps.providerFor(app);
  const installation = { externalId: found.externalId };
  const repo = { id: found.repoId, fullName: found.fullName };
  const context = `ocel/${found.slug}/${synced.kind === "deploy" ? "deploy" : "preview"}`;

  const link = linkOf(synced, { ...found, origin: consoleOrigin() });
  const status = async (state: CommitState) => {
    if (!synced.sha) return;
    await provider.setStatus(installation, repo, {
      sha: synced.sha,
      state,
      context,
      description: describedOf(synced),
      targetUrl: link.href,
    });
  };

  if (synced.kind === "deploy") {
    await status(COMMIT_STATES[synced.status]);
    return;
  }

  const rows = await latestPreviews(found.installationId, found.repoId, synced.pr);
  const own = rows.find((row) => row.job.projectId === synced.projectId);
  const takenOver = synced.status === "canceled" && own?.job.sha === synced.sha;
  const preview = synced.kind === "preview-up" && !takenOver;
  if (preview) await status(COMMIT_STATES[synced.status]);

  await provider.upsertComment(installation, repo, {
    pr: synced.pr,
    marker: PREVIEW_MARKER,
    body: renderPreviewComment(found.fullName, rows),
  });

  const environment = previewEnvironment(synced.pr, found.slug);
  if (preview && synced.sha) {
    const environmentUrl = urlOf(await deploymentOf(synced.projectId, synced.deploymentId));
    await provider.upsertDeployment(installation, repo, {
      environment,
      state: DEPLOYMENT_STATES[synced.status],
      sha: synced.sha,
      logUrl: link.href,
      ...(environmentUrl ? { environmentUrl } : {}),
    });
  }
  if (own?.job.kind === "preview-rm" && own.job.status === "done") {
    await provider.removeEnvironment(installation, repo, environment);
  }
}

export async function linkedRepo(projectId: string) {
  const [linked] = await db
    .select({ installationId: projectRepo.installationId, repoId: projectRepo.repoId })
    .from(projectRepo)
    .where(eq(projectRepo.projectId, projectId));
  return linked;
}

export async function syncJob(jobId: string, deps: SyncDeps): Promise<void> {
  const [synced] = await db.select().from(job).where(eq(job.id, jobId));
  if (!synced) return;
  await report(synced, deps);
  await markSynced(synced.id, synced.revision);
}
