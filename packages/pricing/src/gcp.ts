import { createHash } from "node:crypto";
import type { PriceTier } from "@console/db/schema";
import { env } from "@console/infra";
import { GoogleAuth } from "google-auth-library";
import { canonicalDecimal, compareDecimals, unitsAndNanos } from "./decimal";
import { type Fetch, fetchJson } from "./http";
import { keepsProduct, type ManifestEntry } from "./manifest";
import {
  type CatalogProduct,
  canonicalLine,
  compareProducts,
  type SkippedProduct,
} from "./product";

export const GCP_BILLING = "https://cloudbilling.googleapis.com/v1";
const PAGE_SIZE = 5000;

export type GcpCredentials = { headers(): Promise<Record<string, string>> };

export function gcpApiKey(key: string): GcpCredentials {
  return { headers: async () => ({ "x-goog-api-key": key }) };
}

export function gcpApplicationDefault(project?: string): GcpCredentials {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-billing.readonly"],
    ...(project ? { projectId: project } : {}),
  });
  return {
    headers: async () => {
      const client = await auth.getClient();
      const quotaProject = project ?? (await auth.getProjectId());
      const headers: Record<string, string> = {};
      (await client.getRequestHeaders()).forEach((value, key) => {
        headers[key] = value;
      });
      headers["x-goog-user-project"] = quotaProject;
      return headers;
    },
  };
}

export async function gcpCredentials(options: {
  apiKey?: string;
  project?: string;
}): Promise<GcpCredentials> {
  if (options.apiKey) return gcpApiKey(options.apiKey);
  const credentials = gcpApplicationDefault(options.project);
  try {
    await credentials.headers();
  } catch (error) {
    throw new Error(
      `no GCP_BILLING_API_KEY is set, and Application Default Credentials are unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return credentials;
}

export function gcpFromEnv(): Promise<GcpCredentials> {
  return gcpCredentials({
    apiKey: env.gcpBilling?.GCP_BILLING_API_KEY,
    project: env.CONSOLE_PRICING_GCP_PROJECT,
  });
}

type GcpSku = {
  skuId?: string;
  description?: string;
  category?: {
    serviceDisplayName?: string;
    resourceFamily?: string;
    resourceGroup?: string;
    usageType?: string;
  };
  serviceRegions?: string[];
  pricingInfo?: {
    effectiveTime?: string;
    aggregationInfo?: { aggregationInterval?: string };
    pricingExpression?: {
      usageUnit?: string;
      tieredRates?: { startUsageAmount?: number; unitPrice?: { units?: string; nanos?: number } }[];
    };
  }[];
};

type SkuPage = { skus?: GcpSku[]; nextPageToken?: string };

export async function* gcpSkus(
  fetcher: Fetch,
  serviceId: string,
  credentials: GcpCredentials,
): AsyncGenerator<GcpSku> {
  let token = "";
  do {
    const url = new URL(`${GCP_BILLING}/services/${encodeURIComponent(serviceId)}/skus`);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("currencyCode", "USD");
    if (token) url.searchParams.set("pageToken", token);
    const page = await fetchJson<SkuPage>(fetcher, url.toString(), {
      headers: await credentials.headers(),
    });
    yield* page.skus ?? [];
    token = page.nextPageToken ?? "";
  } while (token);
}

export function gcpRows(
  sku: GcpSku,
  entry: ManifestEntry,
): { products: CatalogProduct[]; skipped: SkippedProduct[] } {
  const skuId = sku.skuId ?? "";
  const category = sku.category ?? {};
  const raw = {
    description: sku.description ?? "",
    resourceFamily: category.resourceFamily ?? "",
    resourceGroup: category.resourceGroup ?? "",
    usageType: category.usageType ?? "",
    serviceDisplayName: category.serviceDisplayName ?? "",
  };
  const regions = [...new Set(sku.serviceRegions ?? [])].filter(
    (region) => entry.regions.length === 0 || entry.regions.includes(region),
  );
  if (regions.length === 0 || !keepsProduct(entry, raw.resourceFamily, raw)) {
    return { products: [], skipped: [] };
  }
  const priced = gcpTiers(sku);
  if (typeof priced === "string") {
    return {
      products: [],
      skipped: regions.map((region) => ({ sku: skuId, region: rowRegion(region), reason: priced })),
    };
  }
  return {
    skipped: [],
    products: regions.map((region) => {
      const suffix = ` in ${region}`;
      return {
        sku: skuId,
        region: rowRegion(region),
        productFamily: raw.resourceFamily,
        unit: priced.unit,
        attributes: {
          description: raw.description.endsWith(suffix)
            ? raw.description.slice(0, -suffix.length)
            : raw.description,
          resourceGroup: raw.resourceGroup,
          usageType: raw.usageType,
          serviceDisplayName: raw.serviceDisplayName,
        },
        tiers: priced.tiers,
        sourceUrl: `https://cloud.google.com/skus?filter=${encodeURIComponent(skuId)}`,
      };
    }),
  };
}

function rowRegion(region: string): string {
  return region === "global" ? "" : region;
}

function gcpTiers(sku: GcpSku): { unit: string; tiers: PriceTier[] } | string {
  const infos = [...(sku.pricingInfo ?? [])].sort((a, b) =>
    (b.effectiveTime ?? "").localeCompare(a.effectiveTime ?? ""),
  );
  const latest = infos[0];
  const expression = latest?.pricingExpression;
  if (!expression) return "it has no pricing info";
  const unit = expression.usageUnit ?? "";
  if (!unit) return "its pricing names no usage unit";
  let tiers: PriceTier[];
  try {
    tiers = (expression.tieredRates ?? []).map((rate) => ({
      start: canonicalDecimal(rate.startUsageAmount ?? 0),
      price: unitsAndNanos(rate.unitPrice?.units ?? "0", rate.unitPrice?.nanos ?? 0),
    }));
  } catch (error) {
    return (error as Error).message;
  }
  tiers.sort((a, b) => compareDecimals(a.start, b.start));
  if (tiers.length === 0) return "it has no tiered rates";
  if (tiers[0]?.start !== "0") return `its first tier starts at ${tiers[0]?.start}`;
  for (const [i, tier] of tiers.entries()) {
    if (tier.start === tiers[i - 1]?.start) return `two of its tiers start at ${tier.start}`;
  }
  const interval = latest?.aggregationInfo?.aggregationInterval;
  if (tiers.length > 1 && interval !== "MONTHLY") {
    return `its tiers reset ${interval ?? "with no stated interval"}, not monthly`;
  }
  return { unit, tiers };
}

export type GcpCatalog = {
  products: CatalogProduct[];
  skipped: SkippedProduct[];
  hash: string;
};

export async function gcpCatalog(
  fetcher: Fetch,
  serviceId: string,
  entry: ManifestEntry,
  credentials: GcpCredentials,
): Promise<GcpCatalog> {
  const products: CatalogProduct[] = [];
  const skipped: SkippedProduct[] = [];
  const seen = new Set<string>();
  for await (const sku of gcpSkus(fetcher, serviceId, credentials)) {
    const rows = gcpRows(sku, entry);
    skipped.push(...rows.skipped);
    for (const product of rows.products) {
      const key = `${product.sku}\u0000${product.region}`;
      if (seen.has(key)) {
        skipped.push({
          sku: product.sku,
          region: product.region,
          reason: "the catalog lists it twice",
        });
        continue;
      }
      seen.add(key);
      products.push(product);
    }
  }
  products.sort(compareProducts);
  const hash = createHash("sha256");
  for (const product of products) hash.update(canonicalLine(product));
  return { products, skipped, hash: hash.digest("hex").slice(0, 12) };
}

export function gcpVersion(hash: string, now: Date): string {
  return `${now.toISOString().slice(0, 10)}-${hash}`;
}

export function sameGcpCatalog(hash: string): (liveVersion: string) => boolean {
  return (liveVersion) => liveVersion.endsWith(`-${hash}`);
}
