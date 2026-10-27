import { randomUUID } from "node:crypto";
import type { Executor } from "@console/db";
import {
  credentialIssuance,
  type IssuancePrincipal,
  type Target,
  type Tier,
  targetTier,
} from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import type { Issuer } from "./issuer";
import { audienceOf, sessionNameOf, subjectPrefixOf } from "./vendors";

export const CREDENTIAL_LIFETIME_SECONDS = 10 * 60;
export const TEST_LIFETIME_SECONDS = 60;
export const CONNECTION_TEST_PROJECT = "connection-test";

export type Issue = {
  target: Target;
  tier: Tier;
  lifetimeSeconds: number;
} & (
  | {
      purpose: "deploy";
      projectId: string;
      principal: Extract<IssuancePrincipal, { kind: "pipeline" }>;
    }
  | { purpose: "test"; principal: Extract<IssuancePrincipal, { kind: "session" }> }
);

export interface Issued {
  token: string;
  jti: string;
  expiresAt: Date;
  sessionName: string;
}

export async function issue(tx: Executor, issuer: Issuer, request: Issue): Promise<Issued> {
  const { target, tier, purpose } = request;
  const project = purpose === "deploy" ? request.projectId : CONNECTION_TEST_PROJECT;
  const jti = randomUUID();
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + request.lifetimeSeconds;
  const token = await issuer.mint({
    aud: audienceOf(target.id),
    sub: `${subjectPrefixOf(target.organizationId, target.id)}:tier:${tier}:project:${project}`,
    org: target.organizationId,
    target: target.id,
    tier,
    project,
    purpose,
    iat: issued,
    nbf: issued,
    exp: expires,
    jti,
  });
  const issuedAt = new Date(issued * 1000);
  const expiresAt = new Date(expires * 1000);
  await tx.insert(credentialIssuance).values({
    organizationId: target.organizationId,
    projectId: purpose === "deploy" ? request.projectId : null,
    targetId: target.id,
    tier,
    purpose,
    principal: request.principal,
    tokenJti: jti,
    issuedAt,
    expiresAt,
  });
  if (purpose === "deploy") {
    await tx
      .update(targetTier)
      .set({ lastIssuedAt: issuedAt })
      .where(and(eq(targetTier.targetId, target.id), eq(targetTier.tier, tier)));
  }
  return { token, jti, expiresAt, sessionName: sessionNameOf(jti) };
}
