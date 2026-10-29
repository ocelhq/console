import type { Executor } from "@console/db";
import { priceCatalog } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { loadCatalog } from "./catalog";
import { canonicalDecimal } from "./decimal";
import type { CatalogProduct } from "./product";

export type SeedProduct = Pick<CatalogProduct, "sku" | "region" | "unit" | "tiers"> &
  Partial<CatalogProduct>;

export type SeedCatalog = {
  vendor: string;
  service: string;
  version: string;
  products: SeedProduct[];
};

export async function seedCatalog(database: Executor, catalog: SeedCatalog): Promise<void> {
  const { vendor, service, version } = catalog;
  await database
    .delete(priceCatalog)
    .where(and(eq(priceCatalog.vendor, vendor), eq(priceCatalog.service, service)));
  const result = await loadCatalog(database, {
    vendor,
    service,
    version,
    manifestSha256: "seed",
    fill: async (sink) => {
      for (const product of catalog.products) {
        await sink.add({
          productFamily: "",
          attributes: {},
          sourceUrl: "",
          ...product,
          tiers: product.tiers.map((tier) => ({
            start: canonicalDecimal(tier.start),
            price: canonicalDecimal(tier.price),
          })),
        });
      }
    },
  });
  if (result.outcome !== "loaded") {
    throw new Error(`the ${vendor} ${service} seed was not loaded: ${result.outcome}`);
  }
}
