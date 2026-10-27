import { randomUUID } from "node:crypto";
import type { Tier } from "@console/db/schema";
import type { Issuer } from "./issuer";
import { audienceOf, sessionNameOf, subjectOf } from "./vendors";

export interface TierToken {
  token: string;
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
  sessionName: string;
}

export interface TierTokenRequest {
  organizationId: string;
  targetId: string;
  tier: Tier;
  projectId: string;
  lifetimeSeconds: number;
}

export const CREDENTIAL_LIFETIME_SECONDS = 10 * 60;

export async function mintTierToken(issuer: Issuer, request: TierTokenRequest): Promise<TierToken> {
  const jti = randomUUID();
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + request.lifetimeSeconds;
  const token = await issuer.mint({
    aud: audienceOf(request.targetId),
    sub: subjectOf(request.organizationId, request.targetId, request.tier, request.projectId),
    org: request.organizationId,
    target: request.targetId,
    tier: request.tier,
    project: request.projectId,
    iat: issued,
    nbf: issued,
    exp: expires,
    jti,
  });
  return {
    token,
    jti,
    issuedAt: new Date(issued * 1000),
    expiresAt: new Date(expires * 1000),
    sessionName: sessionNameOf(jti),
  };
}
