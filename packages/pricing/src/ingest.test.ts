import { readFileSync } from "node:fs";
import { db } from "@console/db";
import { priceCatalog } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import cloudflare from "../catalog/static/cloudflare.json" with { type: "json" };
import type { GetProducts } from "./aws-price-list";
import { fakePriceList, fakeSources, PARITY_BULK } from "./fake-sources";
import { type GcpCredentials, gcpApiKey } from "./gcp";
import type { Fetch } from "./http";
import {
  type IngestDeps,
  type IngestTarget,
  ingestService,
  prepareIngest,
  readManifest,
  SYNCED_CATALOG,
  type SyncedCatalog,
} from "./ingest";
import { lookupPrices, type PriceQueryInput } from "./lookup";

const run = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  await db.delete(priceCatalog).where(like(priceCatalog.vendor, `%-${run}-%`));
});

const EXCLUDE = ["locationType", "fromLocationType", "toLocationType"].map((attribute) => ({
  attribute,
  in: ["AWS Local Zone", "AWS Wavelength Zone"],
}));

type Vendors = { aws: string; gcp: string; static: string };

const AWS_SERVICES: object[] = ["AWSLambda", "AWSDataTransfer", "AmazonCloudWatch"].map(
  (service) => ({ service, exclude: EXCLUDE }),
);

function synced(vendors: Vendors, aws = AWS_SERVICES): SyncedCatalog {
  return {
    manifest: {
      format: 1,
      currency: "USD",
      vendors: [
        {
          vendor: vendors.aws,
          source: "aws-offers",
          services: aws,
        },
        {
          vendor: vendors.gcp,
          source: "gcp-catalog",
          services: [
            { service: "152E-C115-5142", where: [{ attribute: "usageType", in: ["OnDemand"] }] },
          ],
        },
        {
          vendor: vendors.static,
          source: "static",
          services: [
            { service: "workers", file: "static/cloudflare.json" },
            { service: "durable-objects", file: "static/cloudflare.json" },
          ],
        },
      ],
    },
    files: { "static/cloudflare.json": { ...cloudflare, vendor: vendors.static } },
  };
}

const NAT = { service: "AmazonEC2", productFamilies: ["NAT Gateway"], exclude: EXCLUDE };
const LAMBDA_LONDON = {
  service: "AWSLambda",
  regions: ["eu-west-2"],
  productFamilies: ["Serverless"],
  exclude: EXCLUDE,
};

let serial = 0;
function names(): Vendors {
  serial += 1;
  const id = `${run}-${serial}`;
  return { aws: `aws-${id}`, gcp: `gcp-${id}`, static: `cf-${id}` };
}

const withKey = async (): Promise<GcpCredentials> => gcpApiKey("k");

const withoutKey = async (): Promise<GcpCredentials> => {
  throw new Error("no GCP_BILLING_API_KEY is set");
};

function deps(catalog: SyncedCatalog, over: Partial<IngestDeps> = {}): IngestDeps {
  return { database: db, gcp: withKey, fetch: fakeSources().fetch, catalog, ...over };
}

async function target(catalog: SyncedCatalog, vendor: string, service: string) {
  const { targets } = await prepareIngest(
    { gcp: withKey, fetch: fakeSources().fetch },
    readManifest(catalog).entries,
  );
  const found = targets.find((each) => each.vendor === vendor && each.service === service);
  if (!found) throw new Error(`no target ${vendor}/${service}`);
  return found;
}

function query(vendor: string, over: Partial<PriceQueryInput>): PriceQueryInput {
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

async function current(vendor: string, service: string) {
  const [row] = await db
    .select()
    .from(priceCatalog)
    .where(and(eq(priceCatalog.vendor, vendor), eq(priceCatalog.service, service)));
  return row;
}

describe("prepareIngest", () => {
  it("derives AWS usagetype prefixes once, and sends them only to AWS targets", async () => {
    const vendors = names();
    const sources = fakeSources();
    const { targets, dropped } = await prepareIngest(
      { gcp: withKey, fetch: sources.fetch },
      readManifest(synced(vendors)).entries,
    );
    expect(dropped).toBeUndefined();
    expect(targets.map((each) => [each.service, "prefixes" in each])).toEqual([
      ["AWSLambda", true],
      ["AWSDataTransfer", true],
      ["AmazonCloudWatch", true],
      ["152E-C115-5142", false],
      ["workers", false],
      ["durable-objects", false],
    ]);
    expect(
      sources.requested.filter((url) => url.endsWith("/AWSDataTransfer/current/region_index.json")),
    ).toHaveLength(1);
  });

  it("drops GCP targets, saying why, when GCP credentials are unusable", async () => {
    const vendors = names();
    const { targets, dropped } = await prepareIngest(
      { gcp: withoutKey, fetch: fakeSources().fetch },
      readManifest(synced(vendors)).entries,
    );
    expect(dropped).toMatch(/GCP catalogs are not ingested: no GCP_BILLING_API_KEY/);
    expect(targets.map((each) => each.source)).not.toContain("gcp-catalog");
  });
});

describe("ingestService", () => {
  it("ingests an AWS offer's region files and answers the same request in every region", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    const result = await ingestService(
      deps(catalog),
      await target(catalog, vendors.aws, "AWSLambda"),
    );
    expect(result).toMatchObject({
      outcome: "loaded",
      version: "20261022183959",
      skipped: 7,
      via: "bulk-files",
    });

    const answers = await lookupPrices(
      db,
      ["us-east-1", "eu-west-2", "eu-west-1"].map((region) =>
        query(vendors.aws, {
          region,
          attributes: { group: "AWS-Lambda-Requests", usagetype: "Request" },
        }),
      ),
    );
    expect(answers.map((answer) => answer.kind === "price" && answer.sku)).toEqual([
      "GU2ZS9HVP6QTQ7KE",
      "NDYBVXT3KB548Z2A",
      "B5V2RNHAWGVJBZD3",
    ]);
    expect(answers[1]).toMatchObject({
      unit: "Request",
      tiers: [{ start: "0", price: "0.0000002" }],
      catalogVersion: "20261022183959",
    });
    expect(await current(vendors.aws, "AWSLambda")).toMatchObject({
      manifestSha256: readManifest(catalog).sha256,
    });
  });

  it("skips an AWS offer whose version is loaded without downloading a region file", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    const lambda = await target(catalog, vendors.aws, "AWSLambda");
    await ingestService(deps(catalog), lambda);
    const again = fakeSources();
    const result = await ingestService(deps(catalog, { fetch: again.fetch }), lambda);
    expect(result.outcome).toBe("unchanged");
    expect(again.requested).toEqual([
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/region_index.json",
    ]);
  });

  it("stores a transfer two region files both list once, and prices it by destination", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    await ingestService(deps(catalog), await target(catalog, vendors.aws, "AWSDataTransfer"));
    const [toLondon, ambiguous] = await lookupPrices(db, [
      query(vendors.aws, {
        service: "AWSDataTransfer",
        region: "us-east-1",
        attributes: { usagetype: "AWS-Out-Bytes", toRegionCode: "eu-west-2" },
      }),
      query(vendors.aws, {
        service: "AWSDataTransfer",
        region: "us-east-1",
        attributes: { usagetype: "AWS-Out-Bytes" },
      }),
    ]);
    expect(toLondon).toMatchObject({ kind: "price", sku: "JNYSB2CFFU532DFN" });
    expect(ambiguous).toMatchObject({ kind: "ambiguous", matches: 3 });
  });

  it("leaves the loaded catalog untouched when a region file fails", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    const lambda = await target(catalog, vendors.aws, "AWSLambda");
    await ingestService(deps(catalog), lambda);
    const before = await current(vendors.aws, "AWSLambda");

    const newer = fakeSources({
      overrides: {
        "/offers/v1.0/aws/AWSLambda/current/region_index.json": JSON.stringify({
          regions: Object.fromEntries(
            ["us-east-1", "eu-west-2"].map((region) => [
              region,
              {
                currentVersionUrl: `/offers/v1.0/aws/AWSLambda/20261101000000/${region}/index.json`,
              },
            ]),
          ),
        }),
      },
    });
    const failing: Fetch = async (url, init) =>
      url.includes("/20261101000000/eu-west-2/")
        ? new Response("forbidden", { status: 403 })
        : newer.fetch(url, init);
    await expect(ingestService(deps(catalog, { fetch: failing }), lambda)).rejects.toThrow(
      /answered 403/,
    );

    expect(await current(vendors.aws, "AWSLambda")).toEqual(before);
    const [answer] = await lookupPrices(db, [
      query(vendors.aws, { attributes: { usagetype: "Request" } }),
    ]);
    expect(answer).toMatchObject({ kind: "price", catalogVersion: "20261022183959" });
  });

  it("reads an AWS offer through the Price List API when it is given one, and no region file", async () => {
    const vendors = names();
    const catalog = synced(vendors, [NAT]);
    const bulk = fakeSources({ aws: PARITY_BULK });
    const priceList = fakePriceList();
    const result = await ingestService(
      deps(catalog, { fetch: bulk.fetch, awsPriceList: async () => priceList.getProducts }),
      await target(catalog, vendors.aws, "AmazonEC2"),
    );
    expect(result).toMatchObject({
      outcome: "loaded",
      version: "20261028180352",
      via: "price-list-api",
      products: 27,
      skipped: 0,
    });
    expect(bulk.requested).toEqual([
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json",
    ]);
    const [hours] = await lookupPrices(db, [
      query(vendors.aws, {
        service: "AmazonEC2",
        productFamily: "NAT Gateway",
        attributes: { usagetype: "NatGateway-Hours" },
      }),
    ]);
    expect(hours).toMatchObject({ kind: "price", catalogVersion: "20261028180352" });
  });

  it("answers unchanged for an AWS offer whose version is loaded before asking the Price List API", async () => {
    const vendors = names();
    const catalog = synced(vendors, [NAT]);
    const nat = await target(catalog, vendors.aws, "AmazonEC2");
    const fetch = fakeSources({ aws: PARITY_BULK }).fetch;
    await ingestService(
      deps(catalog, { fetch, awsPriceList: async () => fakePriceList().getProducts }),
      nat,
    );
    let opened = 0;
    const result = await ingestService(
      deps(catalog, {
        fetch,
        awsPriceList: async () => {
          opened += 1;
          return fakePriceList().getProducts;
        },
      }),
      nat,
    );
    expect(result.outcome).toBe("unchanged");
    expect(result).not.toHaveProperty("via");
    expect(opened).toBe(0);
  });

  it("skips EC2 on a time-limited task host without the Price List API, keeping its catalog", async () => {
    const vendors = names();
    const catalog = synced(vendors, [NAT]);
    const nat = await target(catalog, vendors.aws, "AmazonEC2");
    await ingestService(
      deps(catalog, {
        fetch: fakeSources({ aws: PARITY_BULK }).fetch,
        awsPriceList: async () => fakePriceList().getProducts,
      }),
      nat,
    );
    const before = await current(vendors.aws, "AmazonEC2");

    const newer = fakeSources({
      aws: PARITY_BULK,
      overrides: {
        "/offers/v1.0/aws/AmazonEC2/current/region_index.json": JSON.stringify({
          regions: {
            "eu-west-2": {
              currentVersionUrl: "/offers/v1.0/aws/AmazonEC2/20261101000000/eu-west-2/index.json",
            },
          },
        }),
      },
    });
    const result = await ingestService(
      deps(catalog, {
        fetch: newer.fetch,
        awsPriceList: async () => undefined,
        timeLimitedTask: true,
      }),
      nat,
    );
    expect(result).toMatchObject({
      outcome: "skipped",
      version: "20261101000000",
      reason: expect.stringMatching(
        /^reading AmazonEC2 from the public price list files takes longer than a task runs on this host/,
      ),
    });
    expect(newer.requested).toEqual([
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json",
    ]);
    expect(await current(vendors.aws, "AmazonEC2")).toEqual(before);
  });

  it("reads EC2 from the public files when the host does not limit a task", async () => {
    const vendors = names();
    const catalog = synced(vendors, [NAT]);
    const result = await ingestService(
      deps(catalog, {
        fetch: fakeSources({ aws: PARITY_BULK }).fetch,
        awsPriceList: async () => undefined,
      }),
      await target(catalog, vendors.aws, "AmazonEC2"),
    );
    expect(result).toMatchObject({ outcome: "loaded", via: "bulk-files", products: 24 });
  });

  it("leaves the loaded catalog untouched when the Price List API fails part way", async () => {
    const vendors = names();
    const catalog = synced(vendors, [LAMBDA_LONDON]);
    const lambda = await target(catalog, vendors.aws, "AWSLambda");
    const fetch = fakeSources({ aws: PARITY_BULK }).fetch;
    await ingestService(deps(catalog, { fetch }), lambda);
    const before = await current(vendors.aws, "AWSLambda");

    const newer = fakeSources({
      aws: PARITY_BULK,
      overrides: {
        "/offers/v1.0/aws/AWSLambda/current/region_index.json": JSON.stringify({
          regions: {
            "eu-west-2": {
              currentVersionUrl: "/offers/v1.0/aws/AWSLambda/20261022183959/eu-west-2/index.json",
            },
          },
        }).replace("20261022183959", "20261101000000"),
      },
    });
    const recorded = fakePriceList().getProducts;
    const failing: GetProducts = async (request) => {
      if (request.NextToken === "page-3") throw new Error("ServiceUnavailableException");
      const page = await recorded(request);
      return {
        ...page,
        PriceList: page.PriceList?.map((raw) =>
          raw.replaceAll('"version":"20261022183959"', '"version":"20261101000000"'),
        ),
      };
    };
    await expect(
      ingestService(
        deps(catalog, { fetch: newer.fetch, awsPriceList: async () => failing }),
        lambda,
      ),
    ).rejects.toThrow(/ServiceUnavailableException/);

    expect(await current(vendors.aws, "AWSLambda")).toEqual(before);
    const [answer] = await lookupPrices(db, [
      query(vendors.aws, { attributes: { usagetype: "Request" } }),
    ]);
    expect(answer).toMatchObject({ kind: "price", catalogVersion: "20261022183959" });
  });

  it("refuses an AWS target that carries no usagetype prefixes", async () => {
    const vendors = names();
    const unprefixed: IngestTarget = {
      vendor: vendors.aws,
      service: "AWSLambda",
      source: "static",
    };
    await expect(ingestService(deps(synced(vendors)), unprefixed)).rejects.toThrow(
      /is ingested from aws-offers, not static/,
    );
  });

  it("ingests a GCP service, and re-ingests it a day later only when its rows changed", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    const gcp = await target(catalog, vendors.gcp, "152E-C115-5142");
    const first = await ingestService(
      deps(catalog, { now: () => new Date("2026-10-28T04:17:00Z") }),
      gcp,
    );
    expect(first.outcome).toBe("loaded");
    expect(first.version).toMatch(/^2026-10-28-[0-9a-f]{12}$/);
    const second = await ingestService(
      deps(catalog, { now: () => new Date("2026-10-29T04:17:00Z") }),
      gcp,
    );
    expect(second).toMatchObject({ outcome: "unchanged", version: first.version });

    const [cpu] = await lookupPrices(db, [
      query(vendors.gcp, {
        service: "152E-C115-5142",
        region: "europe-north1",
        productFamily: "ApplicationServices",
        attributes: {
          description: "Services CPU (Request-based billing)",
          resourceGroup: "Compute",
        },
        unit: "s",
      }),
    ]);
    expect(cpu).toMatchObject({
      kind: "price",
      sku: "4856-B847-F1EB",
      tiers: [{ start: "0", price: "0.000024" }],
      catalogVersion: first.version,
    });
  });

  it("fails a GCP ingest with the reason its credentials are unusable", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    await expect(
      ingestService(deps(catalog, { gcp: withoutKey }), {
        vendor: vendors.gcp,
        service: "152E-C115-5142",
        source: "gcp-catalog",
      }),
    ).rejects.toThrow(/no GCP_BILLING_API_KEY/);
  });

  it("ingests each service of a static catalog as a catalog of its own", async () => {
    const vendors = names();
    const catalog = synced(vendors);
    for (const service of ["workers", "durable-objects"]) {
      await ingestService(deps(catalog), await target(catalog, vendors.static, service));
    }
    expect((await current(vendors.static, "workers"))?.version).toMatch(
      /^2026-09-13-[0-9a-f]{12}$/,
    );
    const [answer] = await lookupPrices(db, [
      query(vendors.static, {
        service: "durable-objects",
        region: "",
        attributes: { metric: "requests" },
      }),
    ]);
    expect(answer).toMatchObject({
      kind: "price",
      sku: "durable-objects-requests",
      sourceUrl: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    });
  });
});

describe("the synced catalog", () => {
  it("imports every static catalog the synced manifest names", () => {
    const files = readManifest().entries.flatMap((entry) =>
      entry.source === "static" ? [entry.file] : [],
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(SYNCED_CATALOG.files[file]).toEqual(
        JSON.parse(readFileSync(new URL(`../catalog/${file}`, import.meta.url), "utf8")),
      );
    }
  });
});
