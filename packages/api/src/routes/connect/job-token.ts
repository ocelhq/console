import { Code, ConnectError } from "@connectrpc/connect";
import { auth, consoleOrigin } from "@console/auth";
import type { Tier } from "@console/db/schema";
import { JOB_AUDIENCE } from "@console/jobs";
import { createLocalJWKSet, decodeJwt, type JWTPayload, jwtVerify } from "jose";

export interface JobClaims {
  organizationId: string;
  projectId: string;
  tier: Tier;
  jobId: string;
  deploymentId: string | undefined;
  preview: string | undefined;
  runner: string;
  slug: string;
  tokenId: string;
  expiresAt: Date;
}

const JOB_SUBJECT = /^org:([^:]+):tier:(production|preview):project:([^:]+)$/;

export function isJobToken(token: string): boolean {
  try {
    const { aud } = decodeJwt(token);
    return aud === JOB_AUDIENCE || (Array.isArray(aud) && aud.includes(JOB_AUDIENCE));
  } catch {
    return false;
  }
}

async function consoleKeys() {
  const response = await auth.handler(new Request(`${consoleOrigin()}/api/auth/jwks`));
  return createLocalJWKSet(await response.json());
}

function text(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function refused(why: string): ConnectError {
  return new ConnectError(`The job token is refused: ${why}`, Code.Unauthenticated);
}

export async function verifyJobToken(token: string): Promise<JobClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, await consoleKeys(), {
      issuer: consoleOrigin(),
      audience: JOB_AUDIENCE,
      algorithms: ["EdDSA"],
      requiredClaims: ["exp", "jti", "sub"],
      clockTolerance: 30,
    }));
  } catch {
    throw refused("this console did not sign it for a job, or it has expired");
  }
  const subject = JOB_SUBJECT.exec(payload.sub ?? "");
  const jobId = text(payload, "job_id");
  const runner = text(payload, "runner");
  const slug = text(payload, "slug");
  if (!subject || !jobId || !runner || !slug || !payload.jti || !payload.exp) {
    throw refused("it names no organization, tier, project, job, runner or slug");
  }
  const [, organizationId = "", tier, projectId = ""] = subject;
  return {
    organizationId,
    projectId,
    tier: tier as Tier,
    jobId,
    deploymentId: text(payload, "deployment_id"),
    preview: text(payload, "preview"),
    runner,
    slug,
    tokenId: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}
