import type { Executor } from "@console/db";
import { priceCatalog, priceProduct } from "@console/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { type CatalogProduct, productProblem, type SkippedProduct } from "./product";

export const BATCH = 1_000;
const SKIPPED_KEPT = 100;

export type ProductSink = {
  add(product: CatalogProduct): Promise<void>;
  skip(skipped: SkippedProduct): void;
};

export type CatalogLoad = {
  vendor: string;
  service: string;
  version: string;
  manifestSha256: string;
  sameAs?: (liveVersion: string) => boolean;
  fill: (sink: ProductSink) => Promise<void>;
};

export type LoadResult = {
  outcome: "loaded" | "unchanged" | "busy";
  vendor: string;
  service: string;
  version: string;
  products: number;
  skipped: number;
  skippedSample: SkippedProduct[];
};

export async function loadCatalog(database: Executor, load: CatalogLoad): Promise<LoadResult> {
  const { vendor, service, version } = load;
  const sameAs = load.sameAs ?? ((live: string) => live === version);
  const untouched = (outcome: "unchanged" | "busy", at: string): LoadResult => ({
    outcome,
    vendor,
    service,
    version: at,
    products: 0,
    skipped: 0,
    skippedSample: [],
  });

  return database.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`price_catalog:${vendor}/${service}`})) as locked`,
    );
    if (!lock.rows[0]?.locked) return untouched("busy", version);

    const current = and(eq(priceCatalog.vendor, vendor), eq(priceCatalog.service, service));
    const [live] = await tx
      .select({ version: priceCatalog.version, manifestSha256: priceCatalog.manifestSha256 })
      .from(priceCatalog)
      .where(current);
    if (live && live.manifestSha256 === load.manifestSha256 && sameAs(live.version)) {
      return untouched("unchanged", live.version);
    }

    await tx.delete(priceCatalog).where(current);
    const [created] = await tx
      .insert(priceCatalog)
      .values({ vendor, service, version, manifestSha256: load.manifestSha256 })
      .returning({ id: priceCatalog.id });
    if (!created) throw new Error(`no ${vendor} ${service} catalog was created`);
    const catalogId = created.id;

    const skippedSample: SkippedProduct[] = [];
    let skipped = 0;
    let pending: CatalogProduct[] = [];
    let writing: Promise<void> = Promise.resolve();
    const flush = () => {
      const rows = pending;
      pending = [];
      writing = writing.then(async () => {
        if (rows.length === 0) return;
        await tx
          .insert(priceProduct)
          .values(rows.map((row) => ({ ...row, catalogId })))
          .onConflictDoNothing();
      });
      return writing;
    };
    try {
      await load.fill({
        add: async (product) => {
          const problem = productProblem(product);
          if (problem) {
            throw new Error(`${vendor} ${service} product ${product.sku} is invalid: ${problem}`);
          }
          pending.push(product);
          if (pending.length >= BATCH) await flush();
        },
        skip: (entry) => {
          skipped += 1;
          if (skippedSample.length < SKIPPED_KEPT) skippedSample.push(entry);
        },
      });
      await flush();
    } catch (error) {
      await writing.catch(() => undefined);
      throw error;
    }

    const [counted] = await tx
      .select({ products: sql<number>`count(*)::int` })
      .from(priceProduct)
      .where(eq(priceProduct.catalogId, catalogId));
    const products = counted?.products ?? 0;
    if (products === 0) {
      throw new Error(`the ${vendor} ${service} catalog ${version} has no products`);
    }
    return { outcome: "loaded", vendor, service, version, products, skipped, skippedSample };
  });
}
