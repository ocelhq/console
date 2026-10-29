import { describe, expect, it } from "vitest";
import { fakeSources } from "./fake-sources";
import { gcpApiKey, gcpCatalog, gcpCredentials, gcpRows, gcpVersion, sameGcpCatalog } from "./gcp";
import { manifestEntry, parseManifest } from "./manifest";

const run = manifestEntry(
  parseManifest({
    format: 1,
    currency: "USD",
    vendors: [
      {
        vendor: "gcp",
        source: "gcp-catalog",
        services: [
          { service: "152E-C115-5142", where: [{ attribute: "usageType", in: ["OnDemand"] }] },
        ],
      },
    ],
  }),
  "gcp",
  "152E-C115-5142",
);

describe("gcpCredentials", () => {
  it("uses an API key when one is set", async () => {
    const credentials = await gcpCredentials({ apiKey: "k-1" });
    expect(await credentials.headers()).toEqual({ "x-goog-api-key": "k-1" });
  });
});

describe("gcpCatalog", () => {
  it("pages through the SKUs with the API key, in USD", async () => {
    const sources = fakeSources();
    const seen: Headers[] = [];
    const recording: typeof sources.fetch = async (url, init) => {
      seen.push(new Headers(init?.headers));
      return sources.fetch(url, init);
    };
    await gcpCatalog(recording, "152E-C115-5142", run, gcpApiKey("k-123"));
    expect(sources.requested).toEqual([
      "https://cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus?pageSize=5000&currencyCode=USD",
      "https://cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus?pageSize=5000&currencyCode=USD&pageToken=page-2",
    ]);
    expect(seen.map((headers) => headers.get("x-goog-api-key"))).toEqual(["k-123", "k-123"]);
  });

  it("explodes a SKU into one row per region, global as the empty region", async () => {
    const { products } = await gcpCatalog(
      fakeSources().fetch,
      "152E-C115-5142",
      run,
      gcpApiKey("k"),
    );
    const cpu = products.filter((product) => product.sku === "4856-B847-F1EB");
    expect(cpu).toHaveLength(24);
    expect(cpu.find((product) => product.region === "europe-north1")).toEqual({
      sku: "4856-B847-F1EB",
      region: "europe-north1",
      productFamily: "ApplicationServices",
      unit: "s",
      attributes: {
        description: "Services CPU (Request-based billing)",
        resourceGroup: "Compute",
        usageType: "OnDemand",
        serviceDisplayName: "Cloud Run",
      },
      tiers: [{ start: "0", price: "0.000024" }],
      sourceUrl: "https://cloud.google.com/skus?filter=4856-B847-F1EB",
    });
    expect(products.find((product) => product.sku === "2DA5-55D3-E679")).toMatchObject({
      region: "",
      unit: "count",
      attributes: { description: "Requests" },
      tiers: [
        { start: "0", price: "0" },
        { start: "2000000", price: "0.0000004" },
      ],
    });
  });

  it("strips only the row's own ' in <region>' from a description", async () => {
    const { products } = await gcpCatalog(
      fakeSources().fetch,
      "152E-C115-5142",
      run,
      gcpApiKey("k"),
    );
    const descriptions = Object.fromEntries(
      products
        .filter(
          (product) =>
            ["011E-3072-CBDB", "SYNT-REPR-0002"].includes(product.sku) ||
            product.region === "europe-west1",
        )
        .map((product) => [`${product.sku}/${product.region}`, product.attributes.description]),
    );
    expect(descriptions["011E-3072-CBDB/us-central1"]).toBe(
      "Services CPU (Instance-based billing)",
    );
    expect(Object.entries(descriptions).filter(([key]) => key.endsWith("/europe-west1"))).toEqual(
      expect.arrayContaining([[expect.any(String), "Services CPU (Instance-based billing)"]]),
    );
  });

  it("keeps only what the manifest's filters keep, and prices a SKU from its latest pricing", async () => {
    const { products } = await gcpCatalog(
      fakeSources().fetch,
      "152E-C115-5142",
      run,
      gcpApiKey("k"),
    );
    expect(products.map((product) => product.sku)).not.toContain("SYNT-COMM-0001");
    expect(products.find((product) => product.sku === "SYNT-REPR-0002")?.tiers).toEqual([
      { start: "0", price: "0.000018" },
    ]);
  });

  it("skips a tiered SKU whose tiers reset other than monthly, and keeps a single-rate one", () => {
    const sku = (interval: string, tiers: { startUsageAmount: number; nanos: number }[]) => ({
      skuId: `SKU-${interval}-${tiers.length}`,
      description: "Entity Writes",
      category: { resourceFamily: "ApplicationServices", usageType: "OnDemand" },
      serviceRegions: ["global"],
      pricingInfo: [
        {
          effectiveTime: "2026-10-28T07:00:00Z",
          aggregationInfo: { aggregationInterval: interval },
          pricingExpression: {
            usageUnit: "count",
            tieredRates: tiers.map(({ startUsageAmount, nanos }) => ({
              startUsageAmount,
              unitPrice: { units: "0", nanos },
            })),
          },
        },
      ],
    });
    const free = [
      { startUsageAmount: 0, nanos: 0 },
      { startUsageAmount: 20000, nanos: 1800 },
    ];

    expect(gcpRows(sku("DAILY", free), run)).toEqual({
      products: [],
      skipped: [
        {
          sku: "SKU-DAILY-2",
          region: "",
          reason: "its tiers reset DAILY, not monthly",
        },
      ],
    });
    expect(gcpRows(sku("MONTHLY", free), run).products).toHaveLength(1);
    expect(gcpRows(sku("DAILY", [{ startUsageAmount: 0, nanos: 1800 }]), run).products).toEqual([
      expect.objectContaining({ tiers: [{ start: "0", price: "0.0000018" }] }),
    ]);
  });

  it("versions the catalog by date and a hash of its rows, which is stable across fetches", async () => {
    const first = await gcpCatalog(fakeSources().fetch, "152E-C115-5142", run, gcpApiKey("k"));
    const second = await gcpCatalog(
      fakeSources({ chunk: 5 }).fetch,
      "152E-C115-5142",
      run,
      gcpApiKey("k"),
    );
    expect(first.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(second.hash).toBe(first.hash);
    const version = gcpVersion(first.hash, new Date("2026-10-28T04:17:00Z"));
    expect(version).toBe(`2026-10-28-${first.hash}`);
    expect(sameGcpCatalog(first.hash)(`2026-10-01-${first.hash}`)).toBe(true);
    expect(sameGcpCatalog(first.hash)("2026-10-01-000000000000")).toBe(false);
  });
});
