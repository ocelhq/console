import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalDecimal } from "./decimal";
import type { CatalogProduct } from "./product";

const decimal = z.string().transform((value, context) => {
  try {
    return canonicalDecimal(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});

const staticCatalog = z
  .object({
    format: z.literal(1),
    vendor: z.string().min(1),
    version: z.string().min(1),
    currency: z.literal("USD"),
    products: z.array(
      z
        .object({
          service: z.string().min(1),
          sku: z.string().min(1),
          region: z.string(),
          productFamily: z.string(),
          attributes: z.record(z.string(), z.string()),
          purchaseOption: z.literal("on_demand"),
          unit: z.string().min(1),
          tiers: z.array(z.object({ start: decimal, price: decimal }).strict()),
          source: z.string().min(1),
          verified: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type StaticCatalog = {
  vendor: string;
  version: string;
  products: (CatalogProduct & { service: string })[];
};

export function parseStaticCatalog(file: string, raw: unknown): StaticCatalog {
  const parsed = staticCatalog.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  const { vendor, version, products } = parsed.data;
  const digest = createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 12);
  return {
    vendor,
    version: `${version}-${digest}`,
    products: products.map(({ purchaseOption: _, verified: __, source, ...product }) => ({
      ...product,
      sourceUrl: source,
    })),
  };
}
