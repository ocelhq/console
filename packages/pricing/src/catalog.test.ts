import { db } from "@console/db";
import { priceCatalog, priceProduct } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CatalogLoad, loadCatalog } from "./catalog";
import { lookupPrices } from "./lookup";
import type { CatalogProduct } from "./product";

const run = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await db.delete(priceCatalog).where(like(priceCatalog.vendor, `test-${run}-%`));
});

let serial = 0;
function vendor(): string {
  serial += 1;
  return `test-${run}-${serial}`;
}

function product(sku: string, price: string, over: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    sku,
    region: "eu-west-2",
    productFamily: "Serverless",
    unit: "Requests",
    attributes: { usagetype: "Request", group: "AWS-Lambda-Requests" },
    tiers: [{ start: "0", price }],
    sourceUrl: `https://prices.test/${sku}`,
    ...over,
  };
}

function load(vendorName: string, version: string, products: CatalogProduct[]): CatalogLoad {
  return {
    vendor: vendorName,
    service: "AWSLambda",
    version,
    manifestSha256: "m",
    fill: async (sink) => {
      for (const item of products) await sink.add(item);
    },
  };
}

async function catalogs(vendorName: string) {
  return db
    .select({
      version: priceCatalog.version,
      products: sql<number>`(select count(*)::int from ${priceProduct} where ${priceProduct.catalogId} = ${priceCatalog.id})`,
    })
    .from(priceCatalog)
    .where(eq(priceCatalog.vendor, vendorName));
}

const query = (vendorName: string) => ({
  vendor: vendorName,
  service: "AWSLambda",
  region: "eu-west-2",
  productFamily: "",
  attributes: { usagetype: "Request" },
  unit: "",
});

describe("loadCatalog", () => {
  it("replaces the catalog, and skips a version already loaded", async () => {
    const name = vendor();
    const first = await loadCatalog(db, load(name, "v1", [product("A", "0.0000002")]));
    expect(first).toMatchObject({ outcome: "loaded", version: "v1", products: 1, skipped: 0 });

    const again = await loadCatalog(db, load(name, "v1", [product("A", "9")]));
    expect(again.outcome).toBe("unchanged");

    await loadCatalog(db, load(name, "v2", [product("A", "2"), product("B", "3")]));
    expect(await catalogs(name)).toEqual([{ version: "v2", products: 2 }]);
    const [answer] = await lookupPrices(db, [query(name)]);
    expect(answer).toMatchObject({ kind: "ambiguous", matches: 2 });
  });

  it("reloads a version when the manifest it was ingested under changed", async () => {
    const name = vendor();
    await loadCatalog(db, load(name, "v1", [product("A", "1")]));
    const reloaded = await loadCatalog(db, {
      ...load(name, "v1", [product("A", "1"), product("B", "2", { productFamily: "Other" })]),
      manifestSha256: "m2",
    });
    expect(reloaded).toMatchObject({ outcome: "loaded", products: 2 });
    expect(await catalogs(name)).toEqual([{ version: "v1", products: 2 }]);
  });

  it("keeps serving the old catalog while a new one loads, and after it fails", async () => {
    const name = vendor();
    await loadCatalog(db, load(name, "v1", [product("A", "1")]));

    let midway: unknown;
    const failing = loadCatalog(db, {
      ...load(name, "v2", []),
      fill: async (sink) => {
        await sink.add(product("A", "2"));
        for (let i = 0; i < 1_500; i += 1) await sink.add(product(`B${i}`, "2"));
        midway = await lookupPrices(db, [query(name)]);
        throw new Error("the region file was cut short");
      },
    });
    await expect(failing).rejects.toThrow(/cut short/);

    expect(midway).toMatchObject([{ kind: "price", catalogVersion: "v1" }]);
    expect(await catalogs(name)).toEqual([{ version: "v1", products: 1 }]);

    const retried = await loadCatalog(db, load(name, "v2", [product("A", "2")]));
    expect(retried.outcome).toBe("loaded");
    expect(await catalogs(name)).toEqual([{ version: "v2", products: 1 }]);
  });

  it("fails a catalog with no products, or with a product whose tiers are not canonical", async () => {
    const name = vendor();
    await loadCatalog(db, load(name, "v1", [product("A", "1")]));
    await expect(loadCatalog(db, load(name, "v2", []))).rejects.toThrow(/has no products/);
    await expect(loadCatalog(db, load(name, "v3", [product("A", "0.10")]))).rejects.toThrow(
      /product A is invalid: tier .* is not two canonical decimals/,
    );
    await expect(
      loadCatalog(
        db,
        load(name, "v4", [product("A", "1", { tiers: [{ start: "5", price: "1" }] })]),
      ),
    ).rejects.toThrow(/first tier starts at 5/);
    expect(await catalogs(name)).toEqual([{ version: "v1", products: 1 }]);
  });

  it("answers busy to a loader that finds another loading the same catalog", async () => {
    const name = vendor();
    let release = () => {};
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = loadCatalog(db, {
      ...load(name, "v1", []),
      fill: async (sink) => {
        await sink.add(product("A", "1"));
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await running;
    const second = await loadCatalog(db, load(name, "v2", [product("A", "2")]));
    release();
    expect(second).toMatchObject({ outcome: "busy", version: "v2" });
    expect(await first).toMatchObject({ outcome: "loaded", version: "v1" });
  });

  it("settles every loader when more race for a catalog than the pool has connections", async () => {
    const name = vendor();
    const loaders = (db.$client.options.max ?? 10) + 5;
    const results = await Promise.all(
      Array.from({ length: loaders }, () => loadCatalog(db, load(name, "v1", [product("A", "1")]))),
    );
    expect(results.filter((result) => result.outcome === "loaded")).toHaveLength(1);
    expect(await catalogs(name)).toEqual([{ version: "v1", products: 1 }]);
  }, 20_000);

  it("reports what it skipped, and stores a product a second source file repeats once", async () => {
    const name = vendor();
    const result = await loadCatalog(db, {
      ...load(name, "v1", []),
      fill: async (sink) => {
        await sink.add(product("G", "1", { region: "" }));
        await sink.add(product("G", "1", { region: "" }));
        await sink.add(product("A", "1"));
        sink.skip({ sku: "X", region: "eu-west-2", reason: "2 OnDemand terms" });
      },
    });
    expect(result).toMatchObject({
      products: 2,
      skipped: 1,
      skippedSample: [{ sku: "X", region: "eu-west-2", reason: "2 OnDemand terms" }],
    });
  });
});
