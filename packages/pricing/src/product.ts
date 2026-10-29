import type { PriceProduct, PriceTier } from "@console/db/schema";
import { compareDecimals, isCanonicalDecimal } from "./decimal";

export type CatalogProduct = Omit<PriceProduct, "catalogId">;

export type SkippedProduct = { sku: string; region: string; reason: string };

export function tierProblem(tiers: readonly PriceTier[]): string | undefined {
  const [first] = tiers;
  if (!first) return "it has no price tiers";
  for (const tier of tiers) {
    if (!isCanonicalDecimal(tier.start) || !isCanonicalDecimal(tier.price)) {
      return `tier ${JSON.stringify(tier)} is not two canonical decimals`;
    }
  }
  if (first.start !== "0") return `its first tier starts at ${first.start}, not 0`;
  for (const [i, tier] of tiers.entries()) {
    const previous = tiers[i - 1];
    if (previous && compareDecimals(previous.start, tier.start) >= 0) {
      return "its tiers do not start in ascending order";
    }
  }
  return undefined;
}

export function productProblem(product: CatalogProduct): string | undefined {
  if (!product.sku) return "it has no sku";
  if (!product.unit) return "it has no unit";
  return tierProblem(product.tiers);
}

export function compareText(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function compareProducts(a: CatalogProduct, b: CatalogProduct): number {
  return compareText(a.sku, b.sku) || compareText(a.region, b.region);
}

export function canonicalLine(product: CatalogProduct): string {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(product.attributes).sort(([a], [b]) =>
    compareText(a, b),
  )) {
    attributes[key] = value;
  }
  return `${JSON.stringify({
    sku: product.sku,
    region: product.region,
    productFamily: product.productFamily,
    unit: product.unit,
    attributes,
    tiers: product.tiers.map((tier) => ({ start: tier.start, price: tier.price })),
    sourceUrl: product.sourceUrl,
  })}\n`;
}
