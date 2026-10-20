import { randomUUID } from "node:crypto";
import { auth } from "./auth";
import { consoleOrigin } from "./origin";

export interface OrganizationGrant {
  audience: string;
  organizationId: string;
  userId: string;
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
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        iss: consoleOrigin(),
        aud: grant.audience,
        sub: `org:${grant.organizationId}`,
        act: grant.userId,
        scope: [...grant.scope],
        jti: randomUUID(),
        iat: issued,
        exp: expires,
      },
    },
  });
  return { token, expiresAt: new Date(expires * 1000) };
}
