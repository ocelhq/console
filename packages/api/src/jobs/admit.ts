import { Code, ConnectError } from "@connectrpc/connect";
import { db } from "@console/db";
import { type Job, type JobKind, job, project, type Tier } from "@console/db/schema";
import { boundRunner, isTerminal, runnerIdOf } from "@console/jobs";
import { and, eq } from "drizzle-orm";
import type { JobClaims } from "../routes/connect/job-token";

function denied(why: string): ConnectError {
  return new ConnectError(`The job token is refused here: ${why}`, Code.PermissionDenied);
}

async function dispatchedJob(claims: JobClaims, projectId: string, tier: Tier): Promise<Job> {
  if (claims.projectId !== projectId || claims.tier !== tier) {
    throw denied(`it is for ${claims.projectId} ${claims.tier}, not ${projectId} ${tier}`);
  }
  const [found] = await db
    .select({ job })
    .from(job)
    .innerJoin(project, eq(project.id, job.projectId))
    .where(
      and(
        eq(job.id, claims.jobId),
        eq(job.projectId, projectId),
        eq(job.tier, tier),
        eq(project.organizationId, claims.organizationId),
      ),
    );
  if (!found || found.job.runnerId !== claims.runner) {
    throw denied(`the console dispatched no job ${claims.jobId} to runner ${claims.runner}`);
  }
  return found.job;
}

export interface JobRecord {
  projectId: string;
  tier: Tier;
  kind: JobKind;
  environmentIdentity: string;
  deploymentId?: string;
  starting?: boolean;
}

const PREVIEW_KINDS: ReadonlySet<JobKind> = new Set(["preview-up", "preview-rm"]);

export async function admitJobRecord(claims: JobClaims, record: JobRecord): Promise<Job> {
  if (record.deploymentId !== undefined && claims.deploymentId !== record.deploymentId) {
    throw denied(
      claims.deploymentId
        ? `it is for deployment ${claims.deploymentId}, not ${record.deploymentId}`
        : "its job records no deployment",
    );
  }
  const found = await dispatchedJob(claims, record.projectId, record.tier);
  if (found.kind !== record.kind) {
    throw denied(`job ${found.id} runs ${found.kind}, not ${record.kind}`);
  }
  if (PREVIEW_KINDS.has(found.kind) && claims.preview !== record.environmentIdentity) {
    throw denied(
      claims.preview
        ? `it is for preview ${claims.preview}, not ${record.environmentIdentity || "the tier's own environment"}`
        : "it names no preview, which its job acts on",
    );
  }
  if (record.starting && isTerminal(found.status)) {
    throw new ConnectError(`Job ${found.id} has already ended`, Code.FailedPrecondition);
  }
  return found;
}

export async function admitJobCredential(
  claims: JobClaims,
  projectId: string,
  tier: Tier,
): Promise<Job> {
  const found = await dispatchedJob(claims, projectId, tier);
  if (found.kind === "build") {
    throw denied(
      `job ${found.id} is a build, which deploys nothing and gets no target credentials`,
    );
  }
  if (isTerminal(found.status)) {
    throw denied(`job ${found.id} has ended`);
  }
  const bound = await boundRunner(projectId, tier);
  if (!bound || runnerIdOf(bound.runner) !== claims.runner) {
    throw denied(
      `runner ${claims.runner} is not the runner bound to ${tier}, so its jobs get no ${tier} credentials`,
    );
  }
  if (!bound.credentials) {
    throw denied(
      `jobs on the runner bound to ${tier} get no target credentials: an admin binds it with credentials on the project's Targets page`,
    );
  }
  return found;
}
