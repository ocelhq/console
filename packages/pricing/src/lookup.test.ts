import { db } from "@console/db";
import { priceCatalog } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupPrices, type PriceQueryInput } from "./lookup";
import { seedCatalog } from "./testing";

const vendor = `lookup-${crypto.randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await db.delete(priceCatalog).where(eq(priceCatalog.vendor, vendor));
});

beforeAll(async () => {
  await setupTestDatabase();
  await seedCatalog(db, {
    vendor,
    service: "AWSLambda",
    version: "20261022183959",
    products: [
      {
        sku: "NDYBVXT3KB548Z2A",
        region: "eu-west-2",
        productFamily: "Serverless",
        unit: "Requests",
        attributes: { group: "AWS-Lambda-Requests", usagetype: "Request" },
        tiers: [{ start: "0", price: "0.0000002000" }],
        sourceUrl:
          "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/20261022183959/eu-west-2/index.json",
      },
      {
        sku: "ZQVCC2M69R4S79XS",
        region: "",
        productFamily: "Serverless",
        unit: "Requests",
        attributes: { group: "AWS-Lambda-Requests", usagetype: "Global-Request" },
        tiers: [
          { start: "0", price: "0" },
          { start: "1000000", price: "0" },
        ],
      },
    ],
  });
  await seedCatalog(db, {
    vendor,
    service: "AmazonCloudWatch",
    version: "20261001000000",
    products: [
      ...["S8QGXX5R2BKKMDSJ", "96K55R2PV3ZZZ3AM"].map((sku, i) => ({
        sku,
        region: "us-east-1",
        productFamily: "Data Payload",
        unit: "GB",
        attributes: { usagetype: "DataProcessing-Bytes", version: i === 0 ? "Current" : "Legacy" },
        tiers: [{ start: "0", price: "0.5" }],
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        sku: `MANY${String(11 - i).padStart(2, "0")}`,
        region: "us-east-1",
        productFamily: "Metric",
        unit: "Metrics",
        attributes: { usagetype: "CW:MetricMonitorUsage" },
        tiers: [{ start: "0", price: "0.3" }],
      })),
    ],
  });
});

function query(over: Partial<PriceQueryInput>): PriceQueryInput {
  return {
    vendor,
    service: "AWSLambda",
    region: "eu-west-2",
    productFamily: "",
    attributes: {},
    unit: "",
    ...over,
  };
}

describe("lookupPrices", () => {
  it("prices a query that matches exactly one product, with the catalog's version", async () => {
    const answers = await lookupPrices(db, [
      query({
        attributes: { usagetype: "Request" },
        productFamily: "Serverless",
        unit: "Requests",
      }),
    ]);
    expect(answers).toEqual([
      {
        kind: "price",
        sku: "NDYBVXT3KB548Z2A",
        unit: "Requests",
        tiers: [{ start: "0", price: "0.0000002" }],
        catalogVersion: "20261022183959",
        sourceUrl:
          "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/20261022183959/eu-west-2/index.json",
      },
    ]);
  });

  it("never picks one of several products: it names the candidates, ascending", async () => {
    const [answer] = await lookupPrices(db, [
      query({
        service: "AmazonCloudWatch",
        region: "us-east-1",
        attributes: { usagetype: "DataProcessing-Bytes" },
      }),
    ]);
    expect(answer).toEqual({
      kind: "ambiguous",
      candidateSkus: ["96K55R2PV3ZZZ3AM", "S8QGXX5R2BKKMDSJ"],
      matches: 2,
    });
  });

  it("names the first ten of more than ten candidates and counts them all", async () => {
    const [answer] = await lookupPrices(db, [
      query({ service: "AmazonCloudWatch", region: "us-east-1", productFamily: "Metric" }),
    ]);
    expect(answer).toEqual({
      kind: "ambiguous",
      candidateSkus: Array.from({ length: 10 }, (_, i) => `MANY${String(i).padStart(2, "0")}`),
      matches: 12,
    });
  });

  it("misses when no product matches every filter, and says when no catalog is seeded", async () => {
    const answers = await lookupPrices(db, [
      query({ attributes: { usagetype: "Request", group: "other" } }),
      query({ attributes: { usagetype: "Request" }, unit: "GB-Seconds" }),
      query({ attributes: { usagetype: "Request" }, region: "us-east-1" }),
      query({ vendor: "gcp", service: "152E-C115-5142" }),
    ]);
    expect(answers.map((answer) => answer.kind === "miss" && answer.reason)).toEqual([
      "no_match",
      "no_match",
      "no_match",
      "catalog_not_seeded",
    ]);
    expect(answers[3]).toMatchObject({ detail: "no gcp catalog for 152E-C115-5142 is seeded" });
  });

  it("treats the empty region as global, not as any region", async () => {
    const answers = await lookupPrices(db, [
      query({ region: "", attributes: { group: "AWS-Lambda-Requests" } }),
    ]);
    expect(answers).toMatchObject([
      {
        kind: "price",
        sku: "ZQVCC2M69R4S79XS",
        tiers: [
          { start: "0", price: "0" },
          { start: "1000000", price: "0" },
        ],
      },
    ]);
  });

  it("answers every query in order, duplicates included", async () => {
    const priced = query({ attributes: { usagetype: "Request" } });
    const missing = query({ attributes: { usagetype: "Nope" } });
    const answers = await lookupPrices(db, [priced, missing, priced]);
    expect(answers.map((answer) => answer.kind)).toEqual(["price", "miss", "price"]);
    expect(await lookupPrices(db, [])).toEqual([]);
  });
});
