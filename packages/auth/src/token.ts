import { randomUUID } from "node:crypto";
import { type Role, roleClaimOf } from "@console/connectors";
import { consoleOrigin } from "./origin";

// Importing ./auth reads the console's settings, which Ocel's discovery forbids: the tasks' import graph reaches this module.
export async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const { auth } = await import("./auth");
  return (await auth.api.signJWT({ body: { payload } })).token;
}

export interface OrganizationGrant {
  audience: string;
  organizationId: string;
  userId: string;
  role: Role;
  scope: readonly string[];
  lifetimeSeconds: number;
}

export interface OrganizationToken {
  token: string;
  expiresAt: Date;
}

export async function signOrganizationToken(grant: OrganizationGrant): Promise<OrganizationToken> {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + grant.lifetimeSeconds;
  const token = await signJwt({
    iss: consoleOrigin(),
    aud: grant.audience,
    sub: `org:${grant.organizationId}`,
    act: grant.userId,
    role: roleClaimOf(grant.role),
    scope: [...grant.scope],
    jti: randomUUID(),
    iat: issued,
    exp: expires,
  });
  return { token, expiresAt: new Date(expires * 1000) };
}
