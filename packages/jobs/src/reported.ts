import { db, type Executor } from "@console/db";
import {
  type Deployment,
  type EnvironmentEvent,
  gitInstallation,
  type Job,
  job,
  projectRepo,
} from "@console/db/schema";
import type { GitRuntime } from "@console/git";
import { and, eq } from "drizzle-orm";

export type ReportedDeployment = Pick<
  Deployment,
  "deploymentId" | "kind" | "tier" | "outcome" | "error" | "git" | "startedAt" | "deployedAt"
>;

export type ReportedEvent = Pick<
  EnvironmentEvent,
  "deploymentId" | "kind" | "tier" | "git" | "occurredAt"
>;

export type ReportedFromCi = {
  projectId: string;
  repositoryId: string;
  pr?: number;
  runUrl: string;
} & ({ deployment: ReportedDeployment } | { event: ReportedEvent });

export type ReportedGit = Pick<GitRuntime, "providerFor"> & {
  store: Pick<GitRuntime["store"], "loadApp">;
};

type JobValues = Omit<typeof job.$inferInsert, "id" | "projectId" | "dedupeKey" | "runUrl">;

export interface PlannedJob {
  projectId: string;
  dedupeKey: string;
  runUrl: string;
  values: JobValues;
}

function jobOf(reported: ReportedFromCi): JobValues | undefined {
  if ("event" in reported) {
    const { event } = reported;
    if (event.kind !== "preview-removed" || !reported.pr) return undefined;
    return {
      kind: "preview-rm",
      status: "done",
      pr: reported.pr,
      sha: event.git?.sha ?? null,
      branch: event.git?.branch ?? null,
      eventAt: event.occurredAt,
      claimedAt: event.occurredAt,
      startedAt: event.occurredAt,
      finishedAt: event.occurredAt,
    };
  }
  const { deployment } = reported;
  const preview = deployment.kind === "preview-up";
  const production = deployment.kind === "deploy" && deployment.tier === "production";
  if (!(preview && reported.pr) && !production) return undefined;
  const startedAt = deployment.startedAt ?? deployment.deployedAt;
  return {
    kind: preview ? "preview-up" : "deploy",
    status: deployment.outcome === "succeeded" ? "done" : "failed",
    pr: preview ? reported.pr : 0,
    sha: deployment.git?.sha ?? null,
    branch: deployment.git?.branch ?? null,
    deploymentId: deployment.deploymentId,
    error: deployment.error,
    eventAt: startedAt,
    claimedAt: startedAt,
    startedAt,
    finishedAt: deployment.deployedAt,
  };
}

interface Followed {
  fullName: string;
  repoId: string;
  externalId: string;
  gitAppId: string;
}

async function pullRequestCommit(
  git: ReportedGit | undefined,
  followed: Followed,
  pr: number,
  sha: string | null | undefined,
): Promise<string | null> {
  if (!git || !sha) return null;
  try {
    const app = await git.store.loadApp(followed.gitAppId);
    if (!app) return null;
    const head = await git
      .providerFor(app)
      .pullRequest(
        { externalId: followed.externalId },
        { id: followed.repoId, fullName: followed.fullName },
        pr,
      );
    if (!head) return null;
    // A pull_request run builds GitHub's test merge commit, which the pull request does not have.
    return sha === head.headSha || sha === head.mergeCommitSha ? head.headSha : null;
  } catch (error) {
    console.error("jobs: the reported preview's pull request was not read", { pr, error });
    return null;
  }
}

export async function planReportedJob(
  reported: ReportedFromCi,
  git: ReportedGit | undefined,
): Promise<PlannedJob | undefined> {
  const values = jobOf(reported);
  if (!values) return undefined;
  const [followed] = await db
    .select({
      fullName: projectRepo.fullName,
      repoId: projectRepo.repoId,
      externalId: gitInstallation.externalId,
      gitAppId: gitInstallation.gitAppId,
    })
    .from(projectRepo)
    .innerJoin(gitInstallation, eq(gitInstallation.id, projectRepo.installationId))
    .where(
      and(
        eq(projectRepo.projectId, reported.projectId),
        eq(projectRepo.deploys, "ci"),
        eq(projectRepo.repoId, reported.repositoryId),
      ),
    );
  if (!followed) return undefined;
  if (values.kind === "preview-up") {
    values.sha = await pullRequestCommit(git, followed, values.pr ?? 0, values.sha);
  }
  const id = "event" in reported ? reported.event.deploymentId : reported.deployment.deploymentId;
  return {
    projectId: reported.projectId,
    dedupeKey: `report:${id}`,
    runUrl: reported.runUrl,
    values,
  };
}

export async function recordReportedJob(
  tx: Executor,
  planned: PlannedJob | undefined,
): Promise<Job[]> {
  if (!planned) return [];
  return tx
    .insert(job)
    .values({
      id: crypto.randomUUID(),
      projectId: planned.projectId,
      dedupeKey: planned.dedupeKey,
      runUrl: planned.runUrl,
      ...planned.values,
    })
    .onConflictDoNothing()
    .returning();
}

export async function notifyReported(
  made: Job[],
  notify: (changed: Job) => Promise<void>,
): Promise<void> {
  for (const changed of made) {
    // The job is stored; a report lost here is sent again by the resync.
    await notify(changed).catch((error: unknown) => {
      console.error("jobs: a reported job went unreported until resync", { id: changed.id, error });
    });
  }
}
