import { signOrganizationToken } from "@console/auth/token";
import { claimOf, type Scope } from "@console/connectors";
import type { Member } from "./member";
import type { ResolvedEndpoint } from "./resolve";

export interface EndpointToken {
  token: string;
  expiresAt: Date;
}

export function signEndpointToken(
  endpoint: Pick<ResolvedEndpoint, "audience">,
  member: Pick<Member, "userId" | "organizationId" | "role">,
  scopes: readonly Scope[],
  lifetimeSeconds: number,
): Promise<EndpointToken> {
  return signOrganizationToken({
    audience: endpoint.audience,
    organizationId: member.organizationId,
    userId: member.userId,
    role: member.role,
    scope: scopes.map(claimOf),
    lifetimeSeconds,
  });
}
