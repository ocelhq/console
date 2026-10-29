import { db } from "@console/db";
import { rateLimitBucket } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { spend } from "./bucket";

const rate = { burst: 3, perHour: 3600 };

function freshKey(): string {
  return `test:${crypto.randomUUID()}`;
}

async function spendTimes(key: string, times: number) {
  const results = [];
  for (let i = 0; i < times; i++) {
    results.push(await spend(db, key, rate));
  }
  return results;
}

describe("spend", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("allows a burst, then refuses with the seconds until a token refills", async () => {
    const key = freshKey();
    const results = await spendTimes(key, 4);
    expect(results.slice(0, 3)).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
    expect(results[3]).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("refills at the hourly rate since the last spend", async () => {
    const key = freshKey();
    await spendTimes(key, 3);
    await db
      .update(rateLimitBucket)
      .set({ refilledAt: sql`now() - interval '2 seconds'` })
      .where(eq(rateLimitBucket.key, key));

    const results = await spendTimes(key, 3);
    expect(results.map((result) => result.allowed)).toEqual([true, true, false]);
  });

  it("never refills past the burst", async () => {
    const key = freshKey();
    await spend(db, key, rate);
    await db
      .update(rateLimitBucket)
      .set({ refilledAt: sql`now() - interval '1 hour'` })
      .where(eq(rateLimitBucket.key, key));

    const results = await spendTimes(key, 4);
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false]);
  });

  it("keeps each key's bucket apart", async () => {
    const spent = freshKey();
    await spendTimes(spent, 3);
    expect(await spend(db, spent, rate)).toMatchObject({ allowed: false });
    expect(await spend(db, freshKey(), rate)).toEqual({ allowed: true });
  });

  it("spends no more than the burst under concurrent calls", async () => {
    const key = freshKey();
    const results = await Promise.all(Array.from({ length: 10 }, () => spend(db, key, rate)));
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
  });

  it("forgets a bucket left full for a day when a new key arrives", async () => {
    const stale = freshKey();
    await spend(db, stale, rate);
    await db
      .update(rateLimitBucket)
      .set({ refilledAt: sql`now() - interval '25 hours'` })
      .where(eq(rateLimitBucket.key, stale));

    await spend(db, freshKey(), rate);

    const left = await db.select().from(rateLimitBucket).where(eq(rateLimitBucket.key, stale));
    expect(left).toEqual([]);
  });
});
