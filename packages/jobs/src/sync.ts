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
import {
  PREVIEW_MARKER,
  type PreviewDeployment,
  type PreviewRow,
  renderPreviewComment,
} from "./render";

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
  if (!found) return undefined;
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
      .orderBy(desc(job.eventAt), desc(job.createdAt))
      .limit(1);
    if (!latest) continue;
    rows.push({
      project: linkedProject.name,
      job: latest,
      deployment: await deploymentOf(linkedProject.id, latest.deploymentId),
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

  const runLog = (reported: Job) => (reported.runUrl ? { targetUrl: reported.runUrl } : {});

  if (synced.kind === "deploy") {
    if (synced.sha) {
      await provider.setStatus(installation, repo, {
        sha: synced.sha,
        state: COMMIT_STATES[synced.status],
        context,
        ...runLog(synced),
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
      ...runLog(synced),
    });
  }

  await provider.upsertComment(installation, repo, {
    pr: synced.pr,
    marker: PREVIEW_MARKER,
    body: renderPreviewComment(found.fullName, rows),
  });

  if (!own) return;
  const environment = previewEnvironment(synced.pr, found.slug);
  if (own.job.kind === "preview-rm") {
    if (own.job.status === "done")
      await provider.removeEnvironment(installation, repo, environment);
    return;
  }
  const state = DEPLOYMENT_STATES[own.job.status];
  if (!state || !own.job.sha) return;
  const environmentUrl = urlOf(own.deployment);
  await provider.upsertDeployment(installation, repo, {
    environment,
    state,
    sha: own.job.sha,
    ...(own.job.runUrl ? { logUrl: own.job.runUrl } : {}),
    ...(environmentUrl ? { environmentUrl } : {}),
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
