import type { Tier } from "@console/db/schema";

export const tiers = ["production", "preview"] as const satisfies readonly Tier[];

export function tierOf(value: string | null | undefined): Tier {
  return value === "preview" ? "preview" : "production";
}

export function otherTier(tier: Tier): Tier {
  return tier === "production" ? "preview" : "production";
}

export function withTier(path: string, tier: Tier): string {
  return tier === "production" ? path : `${path}?env=${tier}`;
}

export const runScopes = ["all", ...tiers] as const;

export type RunScope = (typeof runScopes)[number];

export function runScopeOf(value: string | null | undefined): RunScope {
  return runScopes.includes(value as RunScope) ? (value as RunScope) : "all";
}
