import { PricingClient } from "@aws-sdk/client-pricing";
import { describe, expect, it } from "vitest";
import { awsOffer, fillFromOffer } from "./aws";
import {
  awsPriceList,
  FASTER_IN_BULK,
  fillFromPriceList,
  type GetProducts,
  PRICE_LIST_REGION,
  priceListQueries,
} from "./aws-price-list";
import type { ProductSink } from "./catalog";
import { fakePriceList, fakeSources, PARITY_BULK } from "./fake-sources";
import { type ManifestEntry, manifestEntry, parseManifest } from "./manifest";
import { type CatalogProduct, compareProducts, type SkippedProduct } from "./product";

const PREFIXES = { "us-east-1": "USE1", "eu-west-2": "EUW2" };

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
              in: ["AWS Local Zone", "AWS Wavelength Zone"],
            })),
          },
        ],
      },
    ],
  });
  return { ...manifestEntry(manifest, "aws", name), ...over };
}

function collecting() {
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
  const sorted = () => ({
    products: [...products].sort(compareProducts),
    skipped: [...skipped].sort(
      (a, b) =>
        a.sku.localeCompare(b.sku) ||
        a.region.localeCompare(b.region) ||
        a.reason.localeCompare(b.reason),
    ),
  });
  return { sink, sorted };
}

async function bothPaths(entry: ManifestEntry) {
  const { fetch } = fakeSources({ aws: PARITY_BULK });
  const offer = await awsOffer(fetch, entry.service);
  const bulk = collecting();
  await fillFromOffer(fetch, offer, entry, PREFIXES, bulk.sink);
  const api = collecting();
  const priceList = fakePriceList();
  await fillFromPriceList(priceList.getProducts, offer, entry, PREFIXES, api.sink);
  return { bulk: bulk.sorted(), api: api.sorted(), requests: priceList.requests };
}

describe("the Price List API path, against recorded responses", () => {
  it.each([
    ["AWSLambda", ["Serverless"], 439],
    ["AmazonEC2", ["NAT Gateway"], 24],
  ])(
    "prices %s in eu-west-2 exactly as the bulk region file does",
    async (name, families, count) => {
      const entry = service(name, { regions: ["eu-west-2"], productFamilies: families });
      const { bulk, api } = await bothPaths(entry);
      expect(bulk.products).toHaveLength(count);
      expect(api.products).toEqual(bulk.products);
      expect(api.skipped).toEqual(bulk.skipped);
    },
  );

  it("follows NextToken through every page of each product family", async () => {
    const { requests } = await bothPaths(
      service("AWSLambda", { regions: ["eu-west-2"], productFamilies: ["Serverless"] }),
    );
    expect(requests.map((request) => request.NextToken)).toEqual([
      undefined,
      "page-2",
      "page-3",
      "page-4",
      "page-5",
    ]);
    expect(requests.every((request) => request.ServiceCode === "AWSLambda")).toBe(true);
  });

  it("keeps every region the offer lists when the manifest names none, and ignores the China partition", async () => {
    const { fetch } = fakeSources({ aws: PARITY_BULK });
    const offer = await awsOffer(fetch, "AmazonEC2");
    const { sink, sorted } = collecting();
    await fillFromPriceList(
      fakePriceList().getProducts,
      offer,
      service("AmazonEC2", { productFamilies: ["NAT Gateway"] }),
      PREFIXES,
      sink,
    );
    const { products, skipped } = sorted();
    expect(new Set(products.map((product) => product.region))).toEqual(
      new Set(["eu-west-2", "us-east-1"]),
    );
    expect(skipped).toEqual([]);
    const east = products.find((product) => product.region === "us-east-1");
    expect(east?.sourceUrl).toBe(
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20261028180352/index.json",
    );
    const london = products.find((product) => product.region === "eu-west-2");
    expect(london?.sourceUrl).toBe(
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/20261028180352/eu-west-2/index.json",
    );
  });

  it("fails when the API prices a product in USD at another version than the bulk files", async () => {
    const { fetch } = fakeSources({ aws: PARITY_BULK });
    const offer = await awsOffer(fetch, "AmazonEC2");
    const recorded = fakePriceList().getProducts;
    const lagging: GetProducts = async (request) => {
      const page = await recorded(request);
      return {
        ...page,
        PriceList: page.PriceList?.map((raw) =>
          raw.replaceAll('"version":"20261028180352"', '"version":"20261001000000"'),
        ),
      };
    };
    const { sink } = collecting();
    await expect(
      fillFromPriceList(
        lagging,
        offer,
        service("AmazonEC2", { productFamilies: ["NAT Gateway"] }),
        PREFIXES,
        sink,
      ),
    ).rejects.toThrow(
      /the Price List API serves AmazonEC2 \w+ at version 20261001000000, the bulk files at 20261028180352/,
    );
  });

  it("refuses a region the offer lists no file for, as the bulk path does", async () => {
    const { fetch } = fakeSources({ aws: PARITY_BULK });
    const offer = await awsOffer(fetch, "AmazonEC2");
    await expect(
      fillFromPriceList(
        fakePriceList().getProducts,
        offer,
        service("AmazonEC2", { regions: ["mars-1"], productFamilies: ["NAT Gateway"] }),
        PREFIXES,
        collecting().sink,
      ),
    ).rejects.toThrow(/names AmazonEC2 region mars-1, which AWS lists no file for/);
  });
});

describe("priceListQueries", () => {
  it("asks once per product family, narrowed by every where filter it can match exactly", () => {
    const entry = service("AmazonRDS", {
      productFamilies: ["Database Instance", "Database Storage"],
      where: [
        { attribute: "deploymentOption", in: ["Single-AZ"], productFamilies: [] },
        { attribute: "databaseEngine", in: ["PostgreSQL", "MySQL"], productFamilies: [] },
        { attribute: "volumeType", in: ["General Purpose"], productFamilies: ["Database Storage"] },
        { attribute: "licenseModel", in: [""], productFamilies: [] },
      ],
    });
    const single = { Type: "TERM_MATCH", Field: "deploymentOption", Value: "Single-AZ" };
    expect(priceListQueries(entry)).toEqual([
      [{ Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" }, single],
      [{ Type: "TERM_MATCH", Field: "productFamily", Value: "Database Storage" }, single],
    ]);
  });

  it("asks for the whole service when the manifest names no product family", () => {
    expect(priceListQueries(service("AmazonSNS"))).toEqual([[]]);
  });
});

type Answer = { status: number; type?: string; body: unknown };

function pricingEndpoint(answers: (call: number) => Answer, credentials = some) {
  const requests: unknown[] = [];
  const client = new PricingClient({
    region: PRICE_LIST_REGION,
    credentials,
    maxAttempts: 10,
    retryMode: "adaptive",
    requestHandler: {
      handle: async (request: { body?: unknown }) => {
        requests.push(JSON.parse(String(request.body)));
        const answer = answers(requests.length);
        return {
          response: {
            statusCode: answer.status,
            headers: {
              "content-type": "application/x-amz-json-1.1",
              ...(answer.type ? { "x-amzn-errortype": answer.type } : {}),
            },
            body: new TextEncoder().encode(JSON.stringify(answer.body)),
          },
        };
      },
    },
  });
  return { client, requests };
}

const page: Answer = { status: 200, body: { FormatVersion: "aws_v1", PriceList: ["{}"] } };
const denied: Answer = {
  status: 400,
  type: "AccessDeniedException",
  body: {
    __type: "AccessDeniedException",
    Message:
      "User: arn:aws:sts::123456789012:assumed-role/console-app/worker is not authorized to perform: pricing:GetProducts because no permissions boundary allows the pricing:GetProducts action",
  },
};

async function some() {
  return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
}

async function none(): Promise<never> {
  throw Object.assign(new Error("Could not load credentials from any providers"), {
    name: "CredentialsProviderError",
  });
}

describe("awsPriceList", () => {
  it("reads the bulk files under bulk, without asking the API", async () => {
    const endpoint = pricingEndpoint(() => page);
    expect(
      await awsPriceList("bulk", { client: () => endpoint.client })("AmazonEC2"),
    ).toBeUndefined();
    expect(endpoint.requests).toEqual([]);
  });

  it("reads a service the bulk files serve faster from them under auto, and from the API under api", async () => {
    const endpoint = pricingEndpoint(() => page);
    expect(FASTER_IN_BULK.has("AmazonRDS")).toBe(true);
    expect(
      await awsPriceList("auto", { client: () => endpoint.client })("AmazonRDS"),
    ).toBeUndefined();
    expect(endpoint.requests).toEqual([]);
    expect(await awsPriceList("api", { client: () => endpoint.client })("AmazonRDS")).toBeDefined();
    expect(endpoint.requests).toEqual([{ ServiceCode: "AmazonRDS", MaxResults: 1 }]);
  });

  it("probes the API once, then serves every service through it", async () => {
    const endpoint = pricingEndpoint(() => page);
    const source = awsPriceList("auto", { client: () => endpoint.client });
    const ec2 = await source("AmazonEC2");
    const s3 = await source("AmazonS3");
    expect(ec2).toBeDefined();
    expect(s3).toBe(ec2);
    expect(endpoint.requests).toEqual([{ ServiceCode: "AmazonEC2", MaxResults: 1 }]);
  });

  it("falls back to the bulk files under auto, saying why, when the API denies the console", async () => {
    const endpoint = pricingEndpoint(() => denied);
    const logged: string[] = [];
    const source = awsPriceList("auto", {
      client: () => endpoint.client,
      log: (message) => logged.push(message),
    });
    expect(await source("AmazonEC2")).toBeUndefined();
    expect(await source("AmazonS3")).toBeUndefined();
    expect(endpoint.requests).toHaveLength(1);
    expect(logged).toEqual([
      expect.stringMatching(
        /^pricing: AWS prices are read from the public price list files, since the Price List API refused the console: AccessDeniedException: .*pricing:GetProducts/,
      ),
    ]);
    expect(logged.join("\n")).not.toContain("secret");
  });

  it("falls back to the bulk files under auto when no credentials resolve", async () => {
    const endpoint = pricingEndpoint(() => page, none);
    const logged: string[] = [];
    const source = awsPriceList("auto", {
      client: () => endpoint.client,
      log: (message) => logged.push(message),
    });
    expect(await source("AmazonEC2")).toBeUndefined();
    expect(endpoint.requests).toEqual([]);
    expect(logged).toEqual([
      expect.stringContaining(
        "refused the console: CredentialsProviderError: Could not load credentials from any providers",
      ),
    ]);
  });

  it.each([
    ["the API denies the console", () => pricingEndpoint(() => denied), /AccessDeniedException/],
    ["no credentials resolve", () => pricingEndpoint(() => page, none), /CredentialsProviderError/],
  ])("fails under api when %s", async (_case, endpoint, error) => {
    const { client } = endpoint();
    await expect(awsPriceList("api", { client: () => client })("AmazonEC2")).rejects.toThrow(error);
    await expect(awsPriceList("api", { client: () => client })("AmazonEC2")).rejects.toThrow(
      /^CONSOLE_PRICING_AWS_SOURCE is api, but the Price List API refused the console/,
    );
  });

  it("backs off when the API throttles it", async () => {
    const throttled: Answer = {
      status: 400,
      type: "ThrottlingException",
      body: { __type: "ThrottlingException", message: "Rate exceeded" },
    };
    const endpoint = pricingEndpoint((call) => (call <= 2 ? throttled : page));
    const getProducts = await awsPriceList("auto", { client: () => endpoint.client })("AmazonEC2");
    expect(getProducts).toBeDefined();
    expect(endpoint.requests).toHaveLength(3);
    expect((await getProducts?.({ ServiceCode: "AmazonEC2", MaxResults: 100 }))?.PriceList).toEqual(
      ["{}"],
    );
  });
});
