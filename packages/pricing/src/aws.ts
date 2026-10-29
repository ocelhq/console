import type { PriceTier } from "@console/db/schema";
import type { ProductSink } from "./catalog";
import { canonicalDecimal, compareDecimals } from "./decimal";
import { type Fetch, fetchJson, fetchOk } from "./http";
import { decodeText, jsonMembers } from "./json-members";
import { keepsProduct, type ManifestEntry } from "./manifest";

export const AWS_PRICING = "https://pricing.us-east-1.amazonaws.com";
const OFFERS = "/offers/v1.0/aws";
const REGION_FILES_AT_ONCE = 3;

export type UsagetypePrefixes = Readonly<Record<string, string>>;

export type AwsRegionFile = { region: string; url: string };

export type AwsOffer = { offer: string; version: string; files: AwsRegionFile[] };

type RegionIndex = {
  regions?: Record<string, { regionCode?: string; currentVersionUrl?: string }>;
};

export type OfferProduct = {
  sku?: string;
  productFamily?: string;
  attributes?: Record<string, unknown>;
};

export type OfferTerm = {
  priceDimensions?: Record<
    string,
    { beginRange?: string; endRange?: string; unit?: string; pricePerUnit?: { USD?: string } }
  >;
};

export async function awsOffer(fetcher: Fetch, offer: string): Promise<AwsOffer> {
  const index = await fetchJson<RegionIndex>(
    fetcher,
    `${AWS_PRICING}${OFFERS}/${encodeURIComponent(offer)}/current/region_index.json`,
  );
  const pattern = new RegExp(`^${OFFERS}/${escapeRegExp(offer)}/(\\d+)/([^/]+)/index\\.json$`);
  const versions = new Set<string>();
  const files: AwsRegionFile[] = [];
  for (const [key, entry] of Object.entries(index.regions ?? {})) {
    const match = pattern.exec(entry.currentVersionUrl ?? "");
    if (!match || match[2] !== key) {
      throw new Error(`${offer}'s region index lists ${key} at ${entry.currentVersionUrl}`);
    }
    versions.add(match[1] as string);
    files.push({ region: key, url: `${AWS_PRICING}${entry.currentVersionUrl}` });
  }
  if (versions.size !== 1) {
    throw new Error(
      `${offer}'s region files carry ${versions.size === 0 ? "no version" : `versions ${[...versions].sort().join(", ")}`}, not one`,
    );
  }
  files.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  return { offer, version: [...versions][0] as string, files };
}

export function awsOfferUrl(offer: string, version: string): string {
  return `${AWS_PRICING}${OFFERS}/${offer}/${version}/`;
}

export function selectRegionFiles(offer: AwsOffer, entry: ManifestEntry): AwsRegionFile[] {
  if (entry.regions.length === 0) return offer.files;
  const listed = new Map(offer.files.map((file) => [file.region, file]));
  return entry.regions.map((region) => {
    const file = listed.get(region);
    if (!file)
      throw new Error(
        `the manifest names ${offer.offer} region ${region}, which AWS lists no file for`,
      );
    return file;
  });
}

const INTER_REGION = /^([A-Z0-9]+)-([A-Z0-9]+)-AWS-Out-Bytes$/;

export async function awsUsagetypePrefixes(fetcher: Fetch): Promise<Record<string, string>> {
  const offer = await awsOffer(fetcher, "AWSDataTransfer");
  const prefixes: Record<string, string> = {};
  const record = (region: string, prefix: string, file: string) => {
    const known = prefixes[region];
    if (known !== undefined && known !== prefix) {
      throw new Error(
        `AWSDataTransfer's ${file} file gives ${region} the usagetype prefix ${prefix}, another file ${known}`,
      );
    }
    prefixes[region] = prefix;
  };
  await eachAtOnce(offer.files, REGION_FILES_AT_ONCE, async (file, stopped) => {
    const abort = new AbortController();
    const response = await fetchOk(fetcher, file.url, {
      signal: AbortSignal.any([abort.signal, stopped]),
    });
    try {
      for await (const event of jsonMembers(decodeText(body(response)), [["products"]])) {
        if (event.kind === "end") break;
        const product = JSON.parse(event.json as string) as OfferProduct;
        const attributes = product.attributes ?? {};
        if (attributes.transferType !== "InterRegion Outbound") continue;
        const match = INTER_REGION.exec(String(attributes.usagetype ?? ""));
        const from = attributes.fromRegionCode;
        const to = attributes.toRegionCode;
        if (!match || typeof from !== "string" || typeof to !== "string" || !from || !to) continue;
        record(from, match[1] as string, file.region);
        record(to, match[2] as string, file.region);
      }
    } finally {
      abort.abort();
    }
  });
  if (Object.keys(prefixes).length === 0) {
    throw new Error("AWSDataTransfer's region files name no inter-region usagetype prefixes");
  }
  return prefixes;
}

export type AwsRow = {
  region: string;
  productFamily: string;
  attributes: Record<string, string>;
  unprefixed: boolean;
};

export function awsRow(product: OfferProduct, prefixes: UsagetypePrefixes): AwsRow {
  const raw = product.attributes ?? {};
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const region =
    raw.location === "Any"
      ? ""
      : text("regionCode") || text("fromRegionCode") || text("toRegionCode");
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "regionCode" && typeof value === "string") attributes[key] = value;
  }
  let unprefixed = false;
  const usagetype = attributes.usagetype;
  if (usagetype !== undefined && region && !usagetype.startsWith("Global-")) {
    const prefix = prefixes[region];
    let normalized = usagetype;
    if (prefix !== undefined && normalized.startsWith(`${prefix}-`)) {
      normalized = normalized.slice(prefix.length + 1);
    } else if (normalized.startsWith(`${region}-`)) {
      normalized = normalized.slice(region.length + 1);
    }
    const from = text("fromRegionCode");
    const to = text("toRegionCode");
    const toPrefix = prefixes[to];
    if (from && to && toPrefix !== undefined && normalized.startsWith(`${toPrefix}-`)) {
      normalized = normalized.slice(toPrefix.length + 1);
    }
    attributes.usagetype = normalized;
    unprefixed = prefix === undefined;
  }
  return { region, productFamily: product.productFamily ?? "", attributes, unprefixed };
}

export function awsTiers(term: OfferTerm): { unit: string; tiers: PriceTier[] } | string {
  const dimensions = Object.values(term.priceDimensions ?? {});
  if (dimensions.length === 0) return "its OnDemand term has no price dimensions";
  const units = new Set(dimensions.map((dimension) => dimension.unit ?? ""));
  if (units.size !== 1) return `its price dimensions name units ${[...units].sort().join(", ")}`;
  const unit = [...units][0] as string;
  if (!unit) return "its price dimensions name no unit";
  let ranges: { begin: string; end: string; price: string }[];
  try {
    ranges = dimensions.map((dimension) => {
      const price = dimension.pricePerUnit?.USD;
      if (price === undefined) throw new Error("a price dimension has no USD price");
      const end = dimension.endRange ?? "";
      return {
        begin: canonicalDecimal(dimension.beginRange ?? ""),
        end: end === "Inf" ? "Inf" : canonicalDecimal(end),
        price: canonicalDecimal(price),
      };
    });
  } catch (error) {
    return (error as Error).message;
  }
  ranges.sort((a, b) => compareDecimals(a.begin, b.begin));
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i] as (typeof ranges)[number];
    const next = ranges[i + 1];
    if (!next && range.end !== "Inf") return `its last price range ends at ${range.end}, not Inf`;
    if (next && range.end !== next.begin) {
      return `its price ranges are not contiguous at ${range.begin}`;
    }
  }
  if (ranges[0]?.begin !== "0") return `its first price range begins at ${ranges[0]?.begin}`;
  return { unit, tiers: ranges.map((range) => ({ start: range.begin, price: range.price })) };
}

export type OnDemandTerms = Record<string, OfferTerm>;

export function regionFileUrl(offer: AwsOffer, region: string): string {
  return `${awsOfferUrl(offer.offer, offer.version)}${region}/index.json`;
}

export function keptRow(
  entry: ManifestEntry,
  prefixes: UsagetypePrefixes,
  product: OfferProduct,
): AwsRow | undefined {
  if (!keepsProduct(entry, product.productFamily ?? "", product.attributes ?? {})) return undefined;
  return awsRow(product, prefixes);
}

export async function addOfferProduct(
  sink: ProductSink,
  sku: string,
  row: AwsRow,
  onDemand: OnDemandTerms | undefined,
  sourceUrl: string,
): Promise<boolean> {
  const skip = (reason: string) => {
    sink.skip({ sku, region: row.region, reason });
    return false;
  };
  if (onDemand === undefined) return skip("it has no OnDemand term");
  const terms = Object.values(onDemand);
  if (terms.length !== 1) return skip(`${terms.length} OnDemand terms`);
  const priced = awsTiers(terms[0] as OfferTerm);
  if (typeof priced === "string") return skip(priced);
  await sink.add({
    sku,
    region: row.region,
    productFamily: row.productFamily,
    unit: priced.unit,
    attributes: row.attributes,
    tiers: priced.tiers,
    sourceUrl,
  });
  return true;
}

export function skipUnprefixed(sink: ProductSink, region: string, count: number): void {
  if (count === 0) return;
  sink.skip({
    sku: "",
    region,
    reason: `no usagetype prefix is known for ${count} products' region`,
  });
}

export async function fillFromRegionFile(
  fetcher: Fetch,
  offer: AwsOffer,
  file: AwsRegionFile,
  entry: ManifestEntry,
  prefixes: UsagetypePrefixes,
  sink: ProductSink,
  stopped?: AbortSignal,
): Promise<number> {
  const kept = new Map<string, AwsRow>();
  const sourceUrl = regionFileUrl(offer, file.region);
  let productsDone = false;
  let added = 0;
  let unprefixed = 0;
  const abort = new AbortController();
  const response = await fetchOk(fetcher, file.url, {
    signal: stopped ? AbortSignal.any([abort.signal, stopped]) : abort.signal,
  });
  try {
    const events = jsonMembers(
      decodeText(body(response)),
      [["products"], ["terms", "OnDemand"]],
      (path, sku) => path === 0 || kept.has(sku),
    );
    for await (const event of events) {
      if (event.kind === "end") {
        if (event.path === 0) {
          productsDone = true;
          continue;
        }
        break;
      }
      if (event.path === 0) {
        if (productsDone) throw new Error(`${sourceUrl} lists products after its terms`);
        const row = keptRow(entry, prefixes, JSON.parse(event.json as string) as OfferProduct);
        if (!row) continue;
        if (row.unprefixed) unprefixed += 1;
        kept.set(event.key, row);
        continue;
      }
      if (!productsDone) throw new Error(`${sourceUrl} lists terms before its products`);
      const row = kept.get(event.key);
      if (!row || event.json === undefined) continue;
      kept.delete(event.key);
      const onDemand = JSON.parse(event.json) as OnDemandTerms;
      if (await addOfferProduct(sink, event.key, row, onDemand, sourceUrl)) added += 1;
    }
  } finally {
    abort.abort();
  }
  for (const [sku, row] of kept) await addOfferProduct(sink, sku, row, undefined, sourceUrl);
  skipUnprefixed(sink, file.region, unprefixed);
  return added;
}

export async function fillFromOffer(
  fetcher: Fetch,
  offer: AwsOffer,
  entry: ManifestEntry,
  prefixes: UsagetypePrefixes,
  sink: ProductSink,
): Promise<void> {
  await eachAtOnce(selectRegionFiles(offer, entry), REGION_FILES_AT_ONCE, (file, stopped) =>
    fillFromRegionFile(fetcher, offer, file, entry, prefixes, sink, stopped),
  );
}

async function* body(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
}

export async function eachAtOnce<T>(
  items: readonly T[],
  limit: number,
  run: (item: T, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const stop = new AbortController();
  const failures: unknown[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop.signal.aborted) {
      const item = items[next] as T;
      next += 1;
      try {
        await run(item, stop.signal);
      } catch (error) {
        if (!stop.signal.aborted) failures.push(error);
        stop.abort();
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) throw failures[0];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
