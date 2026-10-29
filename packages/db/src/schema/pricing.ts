import { index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export type PriceTier = { start: string; price: string };

export const priceCatalog = pgTable(
  "price_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendor: text("vendor").notNull(),
    service: text("service").notNull(),
    version: text("version").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
  },
  (table) => [uniqueIndex("price_catalog_vendor_service_uidx").on(table.vendor, table.service)],
);

export const priceProduct = pgTable(
  "price_product",
  {
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => priceCatalog.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    region: text("region").notNull(),
    productFamily: text("product_family").notNull(),
    unit: text("unit").notNull(),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull(),
    tiers: jsonb("tiers").$type<PriceTier[]>().notNull(),
    sourceUrl: text("source_url").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogId, table.sku, table.region] }),
    index("price_product_scope").on(table.catalogId, table.region, table.productFamily),
    index("price_product_attributes").using("gin", table.attributes.op("jsonb_path_ops")),
  ],
);

export type PriceProduct = typeof priceProduct.$inferSelect;
