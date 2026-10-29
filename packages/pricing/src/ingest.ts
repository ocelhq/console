import type { Executor } from "@console/db";
import manifest from "../catalog/manifest.json" with { type: "json" };
import cloudflare from "../catalog/static/cloudflare.json" with { type: "json" };
import { awsOffer, awsUsagetypePrefixes, fillFromOffer, type UsagetypePrefixes } from "./aws";
import { type AwsPriceListFor, fillFromPriceList } from "./aws-price-list";
import { type LoadResult, loadCatalog } from "./catalog";
import { type GcpCredentials, gcpCatalog, gcpVersion, sameGcpCatalog } from "./gcp";
import type { Fetch } from "./http";
import { type Manifest, type ManifestEntry, manifestEntry, parseManifest } from "./manifest";
import { parseStaticCatalog } from "./static";

export type SyncedCatalog = { manifest: unknown; files: Readonly<Record<string, unknown>> };

export const SYNCED_CATALOG: SyncedCatalog = {
  manifest,
  files: { "static/cloudflare.json": cloudflare },
};

export function readManifest(catalog: SyncedCatalog = SYNCED_CATALOG): Manifest {
  return parseManifest(catalog.manifest);
}

export type IngestDeps = {
  database: Executor;
  gcp: () => Promise<GcpCredentials>;
  awsPriceList?: AwsPriceListFor;
  timeLimitedTask?: boolean;
  fetch?: Fetch;
  catalog?: SyncedCatalog;
  now?: () => Date;
};

export type IngestTarget =
  | { vendor: string; service: string; source: "aws-offers"; prefixes: UsagetypePrefixes }
  | { vendor: string; service: string; source: "gcp-catalog" | "static" };

export type PreparedIngest = { targets: IngestTarget[]; dropped?: string };

export async function prepareIngest(
  deps: Pick<IngestDeps, "gcp" | "fetch">,
  entries: readonly ManifestEntry[],
): Promise<PreparedIngest> {
  let kept = entries;
  let dropped: string | undefined;
  if (kept.some((entry) => entry.source === "gcp-catalog")) {
    try {
      await deps.gcp();
    } catch (error) {
      dropped = `GCP catalogs are not ingested: ${error instanceof Error ? error.message : String(error)}`;
      kept = kept.filter((entry) => entry.source !== "gcp-catalog");
    }
  }
  let prefixes: UsagetypePrefixes | undefined;
  const targets: IngestTarget[] = [];
  for (const { vendor, service, source } of kept) {
    if (source === "aws-offers") {
      prefixes ??= await awsUsagetypePrefixes(deps.fetch ?? fetch);
      targets.push({ vendor, service, source, prefixes });
    } else {
      targets.push({ vendor, service, source });
    }
  }
  return { targets, dropped };
}

export const LONGER_THAN_A_TASK_IN_BULK: ReadonlySet<string> = new Set(["AmazonEC2"]);

export type IngestResult = Omit<LoadResult, "outcome"> & {
  outcome: LoadResult["outcome"] | "skipped";
  via?: "price-list-api" | "bulk-files";
  reason?: string;
};

class SkippedIngest extends Error {}

export async function ingestService(deps: IngestDeps, target: IngestTarget): Promise<IngestResult> {
  const catalog = deps.catalog ?? SYNCED_CATALOG;
  const fetcher = deps.fetch ?? fetch;
  const { vendor, service } = target;
  const manifest = readManifest(catalog);
  const entry = manifestEntry(manifest, vendor, service);
  const base = { vendor, service, manifestSha256: manifest.sha256 };

  switch (entry.source) {
    case "aws-offers": {
      if (target.source !== "aws-offers") {
        throw new Error(`${vendor}/${service} is ingested from aws-offers, not ${target.source}`);
      }
      const offer = await awsOffer(fetcher, service);
      let via: "price-list-api" | "bulk-files" = "bulk-files";
      try {
        const result = await loadCatalog(deps.database, {
          ...base,
          version: offer.version,
          fill: async (sink) => {
            const getProducts = await deps.awsPriceList?.(service);
            if (getProducts) {
              via = "price-list-api";
              return fillFromPriceList(getProducts, offer, entry, target.prefixes, sink);
            }
            if (deps.timeLimitedTask && LONGER_THAN_A_TASK_IN_BULK.has(service)) {
              throw new SkippedIngest(
                `reading ${service} from the public price list files takes longer than a task runs on this host; give the console access to the Price List API`,
              );
            }
            return fillFromOffer(fetcher, offer, entry, target.prefixes, sink);
          },
        });
        return result.outcome === "loaded" ? { ...result, via } : result;
      } catch (error) {
        if (!(error instanceof SkippedIngest)) throw error;
        return {
          outcome: "skipped",
          reason: error.message,
          vendor,
          service,
          version: offer.version,
          products: 0,
          skipped: 0,
          skippedSample: [],
        };
      }
    }
    case "gcp-catalog": {
      const fetched = await gcpCatalog(fetcher, service, entry, await deps.gcp());
      return loadCatalog(deps.database, {
        ...base,
        version: gcpVersion(fetched.hash, (deps.now ?? (() => new Date()))()),
        sameAs: sameGcpCatalog(fetched.hash),
        fill: async (sink) => {
          for (const skipped of fetched.skipped) sink.skip(skipped);
          for (const product of fetched.products) await sink.add(product);
        },
      });
    }
    case "static": {
      const raw = catalog.files[entry.file];
      if (raw === undefined) throw new Error(`the synced price catalog has no ${entry.file}`);
      const parsed = parseStaticCatalog(entry.file, raw);
      if (parsed.vendor !== vendor) {
        throw new Error(`${entry.file} is a ${parsed.vendor} catalog, not ${vendor}`);
      }
      return loadCatalog(deps.database, {
        ...base,
        version: parsed.version,
        fill: async (sink) => {
          for (const { service: owner, ...product } of parsed.products) {
            if (owner === service) await sink.add(product);
          }
        },
      });
    }
  }
}
