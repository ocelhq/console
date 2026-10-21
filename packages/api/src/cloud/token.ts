import { getOption } from "@bufbuild/protobuf";
import { signOrganizationToken } from "@console/auth";
import { claim, Scope, ScopeSchema } from "@console/connectors/gen/cloud/v1/scope_pb";
import type { CloudOffer } from "../routes/connect/cloud";
import type { CloudCaller } from "./caller";

const byRole: Record<string, readonly Scope[]> = {
  member: [Scope.APPS_READ, Scope.APPS_WRITE],
  admin: [Scope.APPS_READ, Scope.APPS_WRITE, Scope.VARIABLES_WRITE],
  owner: [Scope.APPS_READ, Scope.APPS_WRITE, Scope.VARIABLES_WRITE, Scope.VARIABLES_REVEAL],
};

const byClaim = new Map<string, Scope>(
  ScopeSchema.values
    .filter((value) => value.number !== Scope.UNSPECIFIED)
    .map((value) => [getOption(value, claim), value.number]),
);

export function claimOf(scope: Scope): string {
  return getOption(ScopeSchema.value[scope], claim);
}

export function scopeOf(named: string): Scope | undefined {
  return byClaim.get(named);
}

export function lackedScope(role: string, wanted: readonly Scope[]): Scope | undefined {
  const granted = new Set(role.split(",").flatMap((named) => byRole[named.trim()] ?? []));
  return wanted.find((scope) => !granted.has(scope));
}

export interface CloudToken {
  token: string;
  expiresAt: Date;
}

export function signCloudToken(
  cloud: CloudOffer,
  caller: Pick<CloudCaller, "userId" | "organizationId">,
  scopes: readonly Scope[],
  lifetimeSeconds: number,
): Promise<CloudToken> {
  return signOrganizationToken({
    audience: cloud.audience,
    organizationId: caller.organizationId,
    userId: caller.userId,
    scope: scopes.map(claimOf),
    lifetimeSeconds,
  });
}
