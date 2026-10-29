import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GetProductsRequest } from "@aws-sdk/client-pricing";
import { AWS_PRICING } from "./aws";
import type { GetProducts, PriceListPage } from "./aws-price-list";
import { GCP_BILLING } from "./gcp";
import type { Fetch } from "./http";

export const TESTDATA = fileURLToPath(new URL("./testdata/", import.meta.url));
export const PARITY_BULK = `${TESTDATA}parity/bulk/`;

export type FakeSources = { fetch: Fetch; requested: string[] };

export function fakeSources(
  options: { chunk?: number; aws?: string; gcp?: string; overrides?: Record<string, string> } = {},
): FakeSources {
  const aws = options.aws ?? `${TESTDATA}aws/`;
  const gcp = options.gcp ?? `${TESTDATA}gcp/`;
  const chunk = options.chunk ?? 97;
  const requested: string[] = [];

  const respond = (text: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(text);
          for (let i = 0; i < bytes.length; i += chunk)
            controller.enqueue(bytes.slice(i, i + chunk));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );

  const fetcher: Fetch = async (input) => {
    const url = new URL(input);
    requested.push(url.toString());
    const override = options.overrides?.[url.pathname];
    if (override !== undefined) return respond(override);
    if (url.origin === new URL(AWS_PRICING).origin) {
      const index = /^\/offers\/v1\.0\/aws\/([^/]+)\/current\/region_index\.json$/.exec(
        url.pathname,
      );
      if (index) {
        const offer = index[1] as string;
        const regions: Record<string, { regionCode: string; currentVersionUrl: string }> = {};
        for (const name of readdirSync(`${aws}${offer}`)) {
          const region = name.replace(/\.json$/, "");
          const { version } = JSON.parse(readFileSync(`${aws}${offer}/${name}`, "utf8")) as {
            version: string;
          };
          regions[region] = {
            regionCode: region,
            currentVersionUrl: `/offers/v1.0/aws/${offer}/${version}/${region}/index.json`,
          };
        }
        return respond(JSON.stringify({ formatVersion: "v1.0", regions }));
      }
      const file = /^\/offers\/v1\.0\/aws\/([^/]+)\/\d+\/([^/]+)\/index\.json$/.exec(url.pathname);
      if (file) return respond(readFileSync(`${aws}${file[1]}/${file[2]}.json`, "utf8"));
    }
    if (input.startsWith(`${GCP_BILLING}/services/`)) {
      const service = /\/services\/([^/]+)\/skus$/.exec(url.pathname)?.[1] as string;
      const page = url.searchParams.get("pageToken") || "page-1";
      return respond(readFileSync(`${gcp}${service}/${page}.json`, "utf8"));
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetcher, requested };
}

export type FakePriceList = { getProducts: GetProducts; requests: GetProductsRequest[] };

export function fakePriceList(dir = `${TESTDATA}parity/price-list/`): FakePriceList {
  const requests: GetProductsRequest[] = [];
  const getProducts: GetProducts = async (request) => {
    requests.push(request);
    const filters = request.Filters ?? [];
    const [family, ...others] = filters;
    if (!family || others.length > 0 || family.Field !== "productFamily") {
      throw new Error(
        `the fake Price List API answers one productFamily filter, not ${JSON.stringify(filters)}`,
      );
    }
    if (family.Type !== "TERM_MATCH")
      throw new Error(`filter type ${family.Type} is not TERM_MATCH`);
    const page = request.NextToken ?? "page-1";
    return JSON.parse(
      readFileSync(`${dir}${request.ServiceCode}/${family.Value}/${page}.json`, "utf8"),
    ) as PriceListPage;
  };
  return { getProducts, requests };
}
