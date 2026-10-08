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
import { and, desc, eq, ne } from "drizzle-orm";
import { markSynced } from "./queue";
import { PREVIEW_MARKER, type PreviewRow, renderPreviewComment } from "./render";

export type SyncDeps = Pick<GitRuntime, "providerFor"> & {
  store: Pick<GitRuntime["store"], "loadApp">;
};

const COMMIT_STATES: Record<Job["status"], CommitState> = {
  queued: "pending",
  claimed: "pending",
  running: "pending",
  done: "success",
  failed: "failure",
  canceled: "error",
};

const DEPLOYMENT_STATES: Partial<Record<Job["status"], DeploymentState>> = {
  queued: "queued",
  claimed: "queued",
  running: "in_progress",
  done: "success",
  failed: "failure",
};

export const previewEnvironment = (pr: number, slug: string) => `preview/pr-${pr}/${slug}`;

async function urlOf(projectId: string, deploymentId: string | null): Promise<string | undefined> {
  if (!deploymentId) return undefined;
  const [found] = await db
    .select({ topology: deployment.topology })
    .from(deployment)
    .where(and(eq(deployment.projectId, projectId), eq(deployment.deploymentId, deploymentId)));
  return found?.topology.apps.flatMap((app) => app.urls)[0];
}

async function latestPreviews(
  installationId: string,
  repoId: string,
  pr: number,
): Promise<PreviewRow[]> {
  const linked = await db
    .select({ id: project.id, name: project.name })
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
          ne(job.kind, "deploy"),
          ne(job.status, "canceled"),
        ),
      )
      .orderBy(desc(job.createdAt))
      .limit(1);
    if (!latest) continue;
    rows.push({
      project: linkedProject.name,
      job: latest,
      url: await urlOf(linkedProject.id, latest.deploymentId),
    });
  }
  return rows;
}

async function report(synced: Job, deps: SyncDeps): Promise<void> {
  const [found] = await db
    .select({
      slug: project.slug,
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

  if (synced.kind === "deploy") {
    if (synced.sha) {
      await provider.setStatus(installation, repo, {
        sha: synced.sha,
        state: COMMIT_STATES[synced.status],
        context,
      });
    }
    return;
  }

  const rows = await latestPreviews(found.installationId, found.repoId, synced.pr);
  const own = rows.find((row) => row.job.projectId === synced.projectId);
  const takenOver = synced.status === "canceled" && own?.job.sha === synced.sha;
  if (synced.sha && synced.kind === "preview-up" && !takenOver) {
    await provider.setStatus(installation, repo, {
      sha: synced.sha,
      state: COMMIT_STATES[synced.status],
      context,
      ...(synced.status === "canceled" ? { description: "Canceled" } : {}),
    });
  }

  await provider.upsertComment(installation, repo, {
    pr: synced.pr,
    marker: PREVIEW_MARKER,
    body: renderPreviewComment(rows),
  });

  if (!own) return;
  const environment = previewEnvironment(synced.pr, found.slug);
  if (own.job.kind === "preview-rm") {
    if (own.job.status === "done")
      await provider.upsertDeployment(installation, repo, { environment, state: "inactive" });
    return;
  }
  const state = DEPLOYMENT_STATES[own.job.status];
  if (!state || !own.job.sha) return;
  await provider.upsertDeployment(installation, repo, {
    environment,
    state,
    sha: own.job.sha,
    ...(own.url ? { environmentUrl: own.url } : {}),
  });
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
