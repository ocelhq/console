import { describe, expect, it } from "vitest";
import { awsOffer, awsRow, awsUsagetypePrefixes, fillFromOffer } from "./aws";
import type { ProductSink } from "./catalog";
import { fakeSources } from "./fake-sources";
import { type ManifestEntry, manifestEntry, parseManifest } from "./manifest";
import type { CatalogProduct, SkippedProduct } from "./product";

const LOCAL_ZONES = ["AWS Local Zone", "AWS Wavelength Zone"];

type Over = Partial<Pick<ManifestEntry, "regions" | "productFamilies" | "where" | "exclude">>;

function service(name: string, over: Over = {}): ManifestEntry {
  const manifest = parseManifest({
    format: 1,
    currency: "USD",
    vendors: [
      {
        vendor: "aws",
        source: "aws-offers",
        services: [
          {
            service: name,
            exclude: ["locationType", "fromLocationType", "toLocationType"].map((attribute) => ({
              attribute,
              in: LOCAL_ZONES,
            })),
          },
        ],
      },
    ],
  });
  return { ...manifestEntry(manifest, "aws", name), ...over };
}

async function ingested(offerName: string, over: Over = {}) {
  const { fetch } = fakeSources({ chunk: 61 });
  const products: CatalogProduct[] = [];
  const skipped: SkippedProduct[] = [];
  const sink: ProductSink = {
    add: async (product) => {
      products.push(product);
    },
    skip: (entry) => {
      skipped.push(entry);
    },
  };
  const prefixes = await awsUsagetypePrefixes(fetch);
  await fillFromOffer(
    fetch,
    await awsOffer(fetch, offerName),
    service(offerName, over),
    prefixes,
    sink,
  );
  return { products, skipped };
}

function row(products: CatalogProduct[], sku: string) {
  const found = products.filter((product) => product.sku === sku);
  expect(found, `products with sku ${sku}`).toHaveLength(found.length > 0 ? found.length : 1);
  return found;
}

describe("awsUsagetypePrefixes", () => {
  it("reads each region's prefix from AWSDataTransfer's inter-region outbound products", async () => {
    const { fetch } = fakeSources();
    expect(await awsUsagetypePrefixes(fetch)).toEqual({
      "us-east-1": "USE1",
      "eu-west-1": "EU",
      "eu-west-2": "EUW2",
      "ap-south-1": "APS3",
    });
  });

  it("aborts when two region files disagree on a prefix", async () => {
    const { fetch } = fakeSources({
      overrides: {
        "/offers/v1.0/aws/AWSDataTransfer/20260916132208/eu-west-2/index.json": JSON.stringify({
          products: {
            X: {
              sku: "X",
              attributes: {
                transferType: "InterRegion Outbound",
                usagetype: "EUW2-USEAST1-AWS-Out-Bytes",
                fromRegionCode: "eu-west-2",
                toRegionCode: "us-east-1",
              },
            },
          },
          terms: { OnDemand: {} },
        }),
      },
    });
    await expect(awsUsagetypePrefixes(fetch)).rejects.toThrow(
      /gives us-east-1 the usagetype prefix (USEAST1|USE1), another file (USE1|USEAST1)/,
    );
  });
});

describe("AWS normalization (spec §4.1)", () => {
  it.each([
    ["AWSLambda", "GU2ZS9HVP6QTQ7KE", "us-east-1", "Request"],
    ["AWSLambda", "NDYBVXT3KB548Z2A", "eu-west-2", "Request"],
    ["AWSLambda", "B5V2RNHAWGVJBZD3", "eu-west-1", "Request"],
    ["awskms", "C7JZRTSGCPF9VEGG", "ap-south-1", "KMS-Keys"],
    ["AWSSecretsManager", "PJHVPQZRWG9TYHS5", "eu-west-2", "AWSSecretsManager-Secrets"],
    ["AmazonCloudFront", "NPFD6SEH9MXS8M4J", "", "US-Requests-Tier2-HTTPS"],
  ])("%s %s lands in region %j as usagetype %s", async (offer, sku, region, usagetype) => {
    const { products } = await ingested(offer);
    const [found] = row(products, sku);
    expect(found?.region).toBe(region);
    expect(found?.attributes.usagetype).toBe(usagetype);
    expect(found?.attributes).not.toHaveProperty("regionCode");
  });

  it("strips both prefixes of an inter-region transfer and keeps its destination queryable", async () => {
    const { products } = await ingested("AWSDataTransfer");
    const [transfer] = row(products, "JNYSB2CFFU532DFN");
    expect(transfer).toMatchObject({
      region: "us-east-1",
      unit: "GB",
      attributes: {
        usagetype: "AWS-Out-Bytes",
        toRegionCode: "eu-west-2",
        fromRegionCode: "us-east-1",
      },
      tiers: [{ start: "0", price: "0.02" }],
    });
  });

  it("keeps an internet transfer's four tiers in order, canonical", async () => {
    const { products } = await ingested("AWSDataTransfer");
    const [out] = row(products, "HQEH3ZWJVT46JHRG");
    expect(out?.attributes.usagetype).toBe("DataTransfer-Out-Bytes");
    expect(out?.tiers).toEqual([
      { start: "0", price: "0.09" },
      { start: "10240", price: "0.085" },
      { start: "51200", price: "0.07" },
      { start: "153600", price: "0.05" },
    ]);
  });

  it("normalizes a global free-tier SKU but skips it, since its one range does not end at Inf", async () => {
    expect(
      awsRow(
        {
          productFamily: "Serverless",
          attributes: {
            location: "Any",
            regionCode: "",
            usagetype: "Global-Request",
            group: "AWS-Lambda-Requests",
          },
        },
        { "us-east-1": "USE1" },
      ),
    ).toEqual({
      region: "",
      productFamily: "Serverless",
      attributes: { location: "Any", usagetype: "Global-Request", group: "AWS-Lambda-Requests" },
      unprefixed: false,
    });
    const { products, skipped } = await ingested("AWSLambda");
    expect(products.map((product) => product.sku)).not.toContain("ZQVCC2M69R4S79XS");
    expect(skipped.filter((entry) => entry.sku === "ZQVCC2M69R4S79XS")).toEqual(
      Array.from({ length: 3 }, () => ({
        sku: "ZQVCC2M69R4S79XS",
        region: "",
        reason: "its last price range ends at 1000000, not Inf",
      })),
    );
  });

  it("writes the region file it read as each product's source", async () => {
    const { products } = await ingested("AWSLambda");
    const [request] = row(products, "NDYBVXT3KB548Z2A");
    expect(request?.sourceUrl).toBe(
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/20261022183959/eu-west-2/index.json",
    );
    expect(request?.tiers).toEqual([{ start: "0", price: "0.0000002" }]);
  });

  it("skips and reports a SKU it cannot price exactly, and drops what the manifest excludes", async () => {
    const { products, skipped } = await ingested("AWSLambda");
    expect(skipped).toEqual(
      expect.arrayContaining([
        { sku: "SYNTHTWOTERMS", region: "us-east-1", reason: "2 OnDemand terms" },
        {
          sku: "SYNTHGAP",
          region: "us-east-1",
          reason: "its price ranges are not contiguous at 0",
        },
        {
          sku: "SYNTHUNITS",
          region: "us-east-1",
          reason: "its price dimensions name units GB, Request",
        },
        { sku: "SYNTHNOTERM", region: "us-east-1", reason: "it has no OnDemand term" },
      ]),
    );
    expect(skipped.filter((entry) => entry.sku.startsWith("SYNTH"))).toHaveLength(4);
    expect(products.map((product) => product.sku)).not.toContain("SYNTHLOCAL");
  });

  it("reads only the region files the manifest names, and refuses one AWS does not list", async () => {
    const { products } = await ingested("AWSLambda", { regions: ["eu-west-2"] });
    expect(new Set(products.map((product) => product.region))).toEqual(new Set(["eu-west-2"]));
    await expect(ingested("AWSLambda", { regions: ["mars-1"] })).rejects.toThrow(
      /names AWSLambda region mars-1, which AWS lists no file for/,
    );
  });

  it("matches each AWS example of a query that had two products, so the rule must name more", async () => {
    const { products } = await ingested("AmazonCloudWatch");
    expect(
      products
        .filter((product) => product.attributes.usagetype === "DataProcessing-Bytes")
        .map((product) => [product.sku, product.attributes.version])
        .sort(),
    ).toEqual([
      ["96K55R2PV3ZZZ3AM", "Legacy"],
      ["S8QGXX5R2BKKMDSJ", "Current"],
    ]);
  });

  it("refuses region files whose versions disagree", async () => {
    const { fetch } = fakeSources({
      overrides: {
        "/offers/v1.0/aws/AWSLambda/current/region_index.json": JSON.stringify({
          regions: {
            "us-east-1": {
              currentVersionUrl: "/offers/v1.0/aws/AWSLambda/1/us-east-1/index.json",
            },
            "eu-west-2": {
              currentVersionUrl: "/offers/v1.0/aws/AWSLambda/2/eu-west-2/index.json",
            },
          },
        }),
      },
    });
    await expect(awsOffer(fetch, "AWSLambda")).rejects.toThrow(/carry versions 1, 2, not one/);
  });

  it("refuses a region file that lists its terms before its products", async () => {
    const { fetch } = fakeSources({
      overrides: {
        "/offers/v1.0/aws/AWSLambda/20261022183959/eu-west-1/index.json":
          '{"terms":{"OnDemand":{"A":{}}},"products":{"A":{"sku":"A","attributes":{}}}}',
      },
    });
    const sink: ProductSink = { add: async () => undefined, skip: () => undefined };
    const offer = await awsOffer(fetch, "AWSLambda");
    await expect(
      fillFromOffer(fetch, offer, service("AWSLambda", { regions: ["eu-west-1"] }), {}, sink),
    ).rejects.toThrow(/lists terms before its products|lists products after its terms/);
  });
});
