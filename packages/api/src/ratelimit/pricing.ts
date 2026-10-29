import type { Executor } from "@console/db";
import { env } from "@console/infra/env";
import { addressKey, clientAddress } from "./address";
import { type Rate, refund, type Spent, spend } from "./bucket";

const ALL_ANONYMOUS_PER_HOUR = 20_000;

export interface PricingLimits {
  trustedProxyHops: number;
  anonymous: Rate;
  organization: Rate;
  allAnonymous: Rate;
}

export function configuredPricingLimits(): PricingLimits {
  return {
    trustedProxyHops: env.CONSOLE_TRUSTED_PROXY_HOPS,
    anonymous: {
      burst: env.CONSOLE_PRICING_ANON_BURST,
      perHour: env.CONSOLE_PRICING_ANON_PER_HOUR,
    },
    organization: {
      burst: env.CONSOLE_PRICING_ORG_BURST,
      perHour: env.CONSOLE_PRICING_ORG_PER_HOUR,
    },
    allAnonymous: {
      burst: Math.ceil(ALL_ANONYMOUS_PER_HOUR / 60),
      perHour: ALL_ANONYMOUS_PER_HOUR,
    },
  };
}

export type PriceLookupCaller =
  | { kind: "session"; session: { activeOrganizationId: string } }
  | { kind: "anonymous" };

export type Limit = "organization" | "address" | "all-anonymous";

export type Admission =
  | { allowed: true }
  | { allowed: false; limit: Limit; retryAfterSeconds: number };

function admitted(spent: Spent, limit: Limit): Admission {
  return spent.allowed ? spent : { ...spent, limit };
}

export async function admitPriceLookup(
  executor: Executor,
  caller: PriceLookupCaller,
  headers: Headers,
  limits: PricingLimits,
): Promise<Admission> {
  switch (caller.kind) {
    case "session":
      return admitted(
        await spend(executor, `org:${caller.session.activeOrganizationId}`, limits.organization),
        "organization",
      );
    case "anonymous": {
      const address = clientAddress(headers.get("x-forwarded-for"), limits.trustedProxyHops);
      const key = address ? addressKey(address) : "ip:unknown";
      const own = await spend(executor, key, limits.anonymous);
      if (!own.allowed) {
        return admitted(own, "address");
      }
      const all = await spend(executor, "anonymous", limits.allAnonymous);
      if (!all.allowed) {
        await refund(executor, key, limits.anonymous);
      }
      return admitted(all, "all-anonymous");
    }
  }
}
