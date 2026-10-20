import { signOrganizationToken } from "@console/auth";
import type { Scope } from "@console/connectors";

export interface Reach {
  connectorId: string;
  organizationId: string;
  userId: string;
  scope: readonly Scope[];
}

const lifetime = 60;

export async function connectorToken(reach: Reach): Promise<string> {
  const { token } = await signOrganizationToken({
    audience: reach.connectorId,
    organizationId: reach.organizationId,
    userId: reach.userId,
    scope: reach.scope,
    lifetimeSeconds: lifetime,
  });
  return token;
}
