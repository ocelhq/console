import { randomBytes, randomUUID } from "node:crypto";
import type { Executor } from "@console/db";
import {
  type DeploymentTrigger,
  deployment,
  type Job,
  type JobKind,
  type JobSpec,
  job,
  type Tier,
} from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { deploys } from "./request";

export interface DispatchInput {
  projectId: string;
  tier: Tier;
  kind: JobKind;
  requestId: string;
  runnerId: string;
  spec: JobSpec;
  pr: number;
  sha: string | null;
  branch: string | null;
  eventAt: Date;
  trigger: DeploymentTrigger;
}

export interface Recorded {
  job: Job;
  created: boolean;
}

export function laneOf(tier: Tier, spec: Pick<JobSpec, "preview">): string {
  return tier === "preview" ? (spec.preview?.name ?? "") : "";
}

export async function recordDispatch(tx: Executor, input: DispatchInput): Promise<Recorded> {
  const deploying = deploys(input.kind) ? input.kind : null;
  const deploymentId = deploying ? randomBytes(16).toString("hex") : null;
  const id = randomUUID();
  const [made] = await tx
    .insert(job)
    .values({
      id,
      projectId: input.projectId,
      kind: input.kind,
      tier: input.tier,
      pr: input.tier === "preview" ? input.pr : 0,
      lane: laneOf(input.tier, input.spec),
      sha: input.sha,
      branch: input.branch,
      dedupeKey: input.requestId,
      eventAt: input.eventAt,
      runnerId: input.runnerId,
      spec: input.spec,
      deploymentId,
    })
    .onConflictDoNothing()
    .returning();
  if (!made) {
    const [found] = await tx
      .select()
      .from(job)
      .where(and(eq(job.projectId, input.projectId), eq(job.dedupeKey, input.requestId)));
    if (!found) throw new Error(`job ${input.requestId} conflicted with a row that is gone`);
    return { job: found, created: false };
  }
  if (deploying && deploymentId) {
    await tx.insert(deployment).values({
      id: randomUUID(),
      projectId: input.projectId,
      deploymentId,
      kind: deploying,
      tier: input.tier,
      environmentIdentity: input.spec.preview?.name ?? "",
      trigger: input.trigger,
      git:
        input.sha || input.branch
          ? {
              ...(input.sha ? { sha: input.sha } : {}),
              ...(input.branch ? { branch: input.branch } : {}),
              dirty: input.spec.git?.dirty ?? false,
            }
          : null,
      jobId: id,
      runnerId: input.runnerId,
    });
  }
  return { job: made, created: true };
}
