import { db } from "@console/db";
import {
  type Deployment,
  type EnvironmentEvent,
  type Job,
  job,
  projectRepo,
} from "@console/db/schema";
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

type JobValues = Omit<typeof job.$inferInsert, "id" | "projectId" | "dedupeKey" | "runUrl">;

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

export async function reportedFromCi(
  reported: ReportedFromCi,
  notify: (changed: Job) => Promise<void>,
): Promise<Job[]> {
  const values = jobOf(reported);
  if (!values) return [];
  const [followed] = await db
    .select({ projectId: projectRepo.projectId })
    .from(projectRepo)
    .where(
      and(
        eq(projectRepo.projectId, reported.projectId),
        eq(projectRepo.deploys, "ci"),
        eq(projectRepo.repoId, reported.repositoryId),
      ),
    );
  if (!followed) return [];

  const id = "event" in reported ? reported.event.deploymentId : reported.deployment.deploymentId;
  const made = await db
    .insert(job)
    .values({
      id: crypto.randomUUID(),
      projectId: reported.projectId,
      dedupeKey: `report:${id}`,
      runUrl: reported.runUrl,
      ...values,
    })
    .onConflictDoNothing()
    .returning();
  for (const changed of made) {
    // The job is stored; a report lost here is sent again by the resync.
    await notify(changed).catch((error: unknown) => {
      console.error("jobs: a reported job went unreported until resync", { id: changed.id, error });
    });
  }
  return made;
}
