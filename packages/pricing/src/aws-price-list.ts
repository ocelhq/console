import {
  type Filter,
  GetProductsCommand,
  type GetProductsRequest,
  PricingClient,
} from "@aws-sdk/client-pricing";
import { env } from "@console/infra";
import {
  type AwsOffer,
  addOfferProduct,
  awsOfferUrl,
  eachAtOnce,
  keptRow,
  type OfferProduct,
  type OnDemandTerms,
  regionFileUrl,
  selectRegionFiles,
  skipUnprefixed,
  type UsagetypePrefixes,
} from "./aws";
import {
  type AwsCredentialsProvider,
  pricingCredentials,
  pricingIdentityFromEnv,
} from "./aws-credentials";
import type { ProductSink } from "./catalog";
import type { ManifestEntry } from "./manifest";

export const PRICE_LIST_REGION = "us-east-1";
const PAGE_SIZE = 100;
const QUERIES_AT_ONCE = 4;

export type PriceListPage = { PriceList?: string[]; NextToken?: string };

export type GetProducts = (request: GetProductsRequest) => Promise<PriceListPage>;

export type AwsSource = "auto" | "api" | "bulk";

type PriceListItem = {
  product?: OfferProduct;
  terms?: { OnDemand?: OnDemandTerms };
  version?: string;
};

export function priceListQueries(entry: ManifestEntry): Filter[][] {
  const term = (field: string, value: string): Filter => ({
    Type: "TERM_MATCH",
    Field: field,
    Value: value,
  });
  const shared = entry.where
    .filter((filter) => filter.productFamilies.length === 0 && filter.in.length === 1)
    .filter((filter) => filter.in[0] !== "")
    .map((filter) => term(filter.attribute, filter.in[0] as string));
  if (entry.productFamilies.length === 0) return [shared];
  return entry.productFamilies.map((family) => [term("productFamily", family), ...shared]);
}

export async function fillFromPriceList(
  getProducts: GetProducts,
  offer: AwsOffer,
  entry: ManifestEntry,
  prefixes: UsagetypePrefixes,
  sink: ProductSink,
): Promise<void> {
  const listed = new Set(offer.files.map((file) => file.region));
  const scope =
    entry.regions.length === 0
      ? undefined
      : new Set(selectRegionFiles(offer, entry).map((file) => file.region));
  const unprefixed = new Map<string, number>();

  const take = async (raw: string) => {
    const item = JSON.parse(raw) as PriceListItem;
    const product = item.product ?? {};
    const sku = product.sku ?? "";
    const row = keptRow(entry, prefixes, product);
    if (!row || (scope && row.region !== "" && !scope.has(row.region))) return;
    if (item.version !== offer.version) {
      if (!pricesInUsd(item)) return;
      throw new Error(
        `the Price List API serves ${offer.offer} ${sku} at version ${item.version}, the bulk files at ${offer.version}`,
      );
    }
    if (row.unprefixed) unprefixed.set(row.region, (unprefixed.get(row.region) ?? 0) + 1);
    const sourceUrl = listed.has(row.region)
      ? regionFileUrl(offer, row.region)
      : `${awsOfferUrl(offer.offer, offer.version)}index.json`;
    await addOfferProduct(sink, sku, row, item.terms?.OnDemand, sourceUrl);
  };

  await eachAtOnce(priceListQueries(entry), QUERIES_AT_ONCE, async (filters, stopped) => {
    let token: string | undefined;
    do {
      if (stopped.aborted) return;
      const page = await getProducts({
        ServiceCode: offer.offer,
        Filters: filters,
        MaxResults: PAGE_SIZE,
        NextToken: token,
      });
      for (const raw of page.PriceList ?? []) await take(raw);
      token = page.NextToken;
    } while (token);
  });
  for (const [region, count] of unprefixed) skipUnprefixed(sink, region, count);
}

function pricesInUsd(item: PriceListItem): boolean {
  return Object.values(item.terms?.OnDemand ?? {}).some((term) =>
    Object.values(term.priceDimensions ?? {}).some(
      (dimension) => dimension.pricePerUnit?.USD !== undefined,
    ),
  );
}

export const FASTER_IN_BULK: ReadonlySet<string> = new Set([
  "AWSDataTransfer",
  "AWSLambda",
  "AmazonECS",
  "AmazonElastiCache",
  "AmazonRDS",
]);

export type AwsPriceListFor = (service: string) => Promise<GetProducts | undefined>;

export type AwsPriceListOptions = {
  client?: () => PricingClient;
  log?: (message: string) => void;
};

export function awsPriceList(
  source: AwsSource,
  options: AwsPriceListOptions = {},
): AwsPriceListFor {
  const client = options.client ?? (() => pricingClient(undefined));
  const log = options.log ?? console.warn;
  let opened: Promise<GetProducts | undefined> | undefined;

  const open = async (service: string): Promise<GetProducts | undefined> => {
    const pricing = client();
    const getProducts: GetProducts = async (request) => {
      const page = await pricing.send(new GetProductsCommand(request));
      return {
        PriceList: (page.PriceList as unknown[] | undefined)?.map(String),
        NextToken: page.NextToken,
      };
    };
    try {
      await getProducts({ ServiceCode: service, MaxResults: 1 });
    } catch (error) {
      const why = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (source === "api") {
        throw new Error(
          `CONSOLE_PRICING_AWS_SOURCE is api, but the Price List API refused the console: ${why}`,
        );
      }
      log(
        `pricing: AWS prices are read from the public price list files, since the Price List API refused the console: ${why}`,
      );
      return undefined;
    }
    return getProducts;
  };

  return async (service) => {
    if (source === "bulk" || (source === "auto" && FASTER_IN_BULK.has(service))) return undefined;
    opened ??= open(service);
    return opened;
  };
}

export function pricingClient(credentials: AwsCredentialsProvider | undefined): PricingClient {
  return new PricingClient({
    region: PRICE_LIST_REGION,
    maxAttempts: 10,
    retryMode: "adaptive",
    ...(credentials ? { credentials } : {}),
  });
}

let fromEnv: PricingClient | undefined;

export function awsPriceListFromEnv(): AwsPriceListFor {
  return awsPriceList(env.CONSOLE_PRICING_AWS_SOURCE, {
    client: () => {
      fromEnv ??= pricingClient(pricingCredentials(pricingIdentityFromEnv()));
      return fromEnv;
    },
  });
}
