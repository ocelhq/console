import { db, type Executor } from "@console/db";
import { rateLimitBucket } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addressKey } from "./address";
import { admitPriceLookup, type PricingLimits } from "./pricing";

function freshAddress(): string {
  return `2001:db8:${Array.from(crypto.getRandomValues(new Uint16Array(2)), (group) => group.toString(16)).join(":")}::1`;
}

async function tokensOf(executor: Executor, key: string): Promise<number | undefined> {
  const [row] = await executor
    .select({ tokens: rateLimitBucket.tokens })
    .from(rateLimitBucket)
    .where(eq(rateLimitBucket.key, key));
  return row?.tokens;
}

async function rolledBack(run: (tx: Executor) => Promise<void>): Promise<void> {
  const done = new Error("rolled back");
  await db
    .transaction(async (tx) => {
      await run(tx);
      throw done;
    })
    .catch((error: unknown) => {
      if (error !== done) {
        throw error;
      }
    });
}

const limits = (overrides: Partial<PricingLimits>): PricingLimits => ({
  trustedProxyHops: 1,
  anonymous: { burst: 2, perHour: 3600 },
  organization: { burst: 2, perHour: 3600 },
  allAnonymous: { burst: 2, perHour: 3600 },
  ...overrides,
});

describe("admitPriceLookup", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("refuses past the limit on all anonymous callers and keeps the caller's own token", async () => {
    const address = freshAddress();
    const headers = new Headers({ "X-Forwarded-For": address });
    await rolledBack(async (tx) => {
      const drained = limits({ allAnonymous: { burst: 1, perHour: 3600 } });
      await admitPriceLookup(tx, { kind: "anonymous" }, headers, drained);

      expect(await admitPriceLookup(tx, { kind: "anonymous" }, headers, drained)).toEqual({
        allowed: false,
        limit: "all-anonymous",
        retryAfterSeconds: 1,
      });
      expect(await tokensOf(tx, addressKey(address))).toBe(1);
    });
  });

  it("leaves the limit on all anonymous callers alone when the address is past its own", async () => {
    const address = freshAddress();
    const headers = new Headers({ "X-Forwarded-For": address });
    await rolledBack(async (tx) => {
      const own = limits({ anonymous: { burst: 1, perHour: 3600 } });
      await admitPriceLookup(tx, { kind: "anonymous" }, headers, own);
      const before = await tokensOf(tx, "anonymous");

      expect(await admitPriceLookup(tx, { kind: "anonymous" }, headers, own)).toEqual({
        allowed: false,
        limit: "address",
        retryAfterSeconds: 1,
      });
      expect(await tokensOf(tx, "anonymous")).toBe(before);
    });
  });

  it("limits a session by its organization, whatever its address", async () => {
    const organizationId = crypto.randomUUID();
    const caller = {
      kind: "session" as const,
      session: { userId: crypto.randomUUID(), activeOrganizationId: organizationId },
    };
    await rolledBack(async (tx) => {
      const one = limits({ organization: { burst: 1, perHour: 3600 } });
      await admitPriceLookup(tx, caller, new Headers({ "X-Forwarded-For": freshAddress() }), one);

      expect(
        await admitPriceLookup(tx, caller, new Headers({ "X-Forwarded-For": freshAddress() }), one),
      ).toEqual({ allowed: false, limit: "organization", retryAfterSeconds: 1 });
    });
  });
});
