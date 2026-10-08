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

export const tierScopes = ["all", ...tiers] as const;

export type TierScope = (typeof tierScopes)[number];

export function tierScopeOf(value: string | null | undefined): TierScope {
  return tierScopes.includes(value as TierScope) ? (value as TierScope) : "all";
}
