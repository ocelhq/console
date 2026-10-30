import { type DescEnumValue, type DescMethod, getOption, hasOption } from "@bufbuild/protobuf";
import {
  claim,
  least_role,
  Role,
  RoleSchema,
  required,
  Scope,
  ScopeSchema,
} from "./gen/common/scope/v1/scope_pb";

export { Role, Scope, ScopeSchema };

export function requiredScope(method: DescMethod): Scope | undefined {
  return hasOption(method, required) ? getOption(method, required) : undefined;
}

export function leastRoleOf(value: DescEnumValue | undefined): Role | undefined {
  return value !== undefined && hasOption(value, least_role)
    ? getOption(value, least_role)
    : undefined;
}

export function isUserScope(scope: Scope): boolean {
  return leastRoleOf(ScopeSchema.value[scope]) !== undefined;
}

export const USER_SCOPES: readonly Scope[] = ScopeSchema.values
  .map((value) => value.number as Scope)
  .filter(isUserScope);

export function claimOf(scope: Scope): string {
  const value = ScopeSchema.value[scope];
  return value === undefined ? "" : getOption(value, claim);
}

export function roleClaimOf(role: Role): string {
  const value = RoleSchema.value[role];
  return value === undefined ? "" : getOption(value, claim);
}

export function scopeName(scope: Scope): string {
  return claimOf(scope) || (ScopeSchema.value[scope]?.name ?? String(scope));
}

const claimed = new Map(USER_SCOPES.map((scope) => [claimOf(scope), scope]));

export function scopeClaimed(named: string): Scope | undefined {
  return claimed.get(named);
}

export function reaches(role: Role, least: Role | undefined): boolean {
  return least !== undefined && least !== Role.UNSPECIFIED && role >= least;
}

export type ScopeRefusal = { scope: Scope; because: "not-user" | "role" | "endpoint" };

export function refusedScope(
  role: Role,
  allowed: readonly Scope[],
  wanted: readonly Scope[],
): ScopeRefusal | undefined {
  for (const scope of wanted) {
    if (!isUserScope(scope)) return { scope, because: "not-user" };
    if (!reaches(role, leastRoleOf(ScopeSchema.value[scope]))) return { scope, because: "role" };
    if (!allowed.includes(scope)) return { scope, because: "endpoint" };
  }
  return undefined;
}

export function scopeForCall(
  role: Role,
  allowed: readonly Scope[],
  method: DescMethod,
): Scope | undefined {
  const scope = requiredScope(method);
  return scope !== undefined && refusedScope(role, allowed, [scope]) === undefined
    ? scope
    : undefined;
}
