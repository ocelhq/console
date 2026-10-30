import { randomUUID } from "node:crypto";
import { consoleOrigin } from "@console/auth/origin";
import { signJwt } from "@console/auth/token";
import type { Tier } from "@console/db/schema";

export const JOB_AUDIENCE = "ocel-job";

export const JOB_TIMEOUT_SECONDS = 2 * 60 * 60;

export const JOB_GRACE_SECONDS = 10 * 60;

export interface JobGrant {
  organizationId: string;
  projectId: string;
  tier: Tier;
  jobId: string;
  deploymentId: string | null;
  preview: string | null;
  runnerId: string;
  slug: string;
}

export interface JobToken {
  token: string;
  expiresAt: Date;
}

export async function signJobToken(grant: JobGrant, now = new Date()): Promise<JobToken> {
  const issued = Math.floor(now.getTime() / 1000);
  const expires = issued + JOB_TIMEOUT_SECONDS + JOB_GRACE_SECONDS;
  const token = await signJwt({
    iss: consoleOrigin(),
    aud: JOB_AUDIENCE,
    sub: `org:${grant.organizationId}:tier:${grant.tier}:project:${grant.projectId}`,
    job_id: grant.jobId,
    ...(grant.deploymentId ? { deployment_id: grant.deploymentId } : {}),
    ...(grant.preview ? { preview: grant.preview } : {}),
    runner: grant.runnerId,
    slug: grant.slug,
    jti: randomUUID(),
    iat: issued,
    exp: expires,
  });
  return { token, expiresAt: new Date(expires * 1000) };
}
