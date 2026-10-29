import type { Executor } from "@console/db";
import type { PriceTier } from "@console/db/schema";
import { sql } from "drizzle-orm";

export type PriceQueryInput = {
  vendor: string;
  service: string;
  region: string;
  productFamily: string;
  attributes: Record<string, string>;
  unit: string;
};

export type PriceAnswerResult =
  | {
      kind: "price";
      sku: string;
      unit: string;
      tiers: PriceTier[];
      catalogVersion: string;
      sourceUrl: string;
    }
  | { kind: "miss"; reason: "catalog_not_seeded" | "no_match"; detail: string }
  | { kind: "ambiguous"; candidateSkus: string[]; matches: number };

export const CANDIDATES = 10;

type Unmatched = {
  i: number;
  version: string | null;
  sku: null;
  unit: null;
  tiers: null;
  source_url: null;
  matches: null;
};

type Matched = {
  i: number;
  version: string;
  sku: string;
  unit: string;
  tiers: PriceTier[];
  source_url: string;
  matches: number;
};

export async function lookupPrices(
  db: Executor,
  queries: readonly PriceQueryInput[],
): Promise<PriceAnswerResult[]> {
  if (queries.length === 0) return [];
  const batch = JSON.stringify(
    queries.map((query, i) => ({
      i,
      vendor: query.vendor,
      service: query.service,
      region: query.region,
      product_family: query.productFamily,
      attributes: query.attributes,
      unit: query.unit,
    })),
  );
  const result = await db.execute<Matched | Unmatched>(sql`
    select q.i, c.version, m.sku, m.unit, m.tiers, m.source_url, m.matches
    from jsonb_to_recordset(${batch}::jsonb) as q(i int, vendor text, service text, region text,
      product_family text, attributes jsonb, unit text)
    left join price_catalog c on c.vendor = q.vendor and c.service = q.service
    left join lateral (
      select p.sku, p.unit, p.tiers, p.source_url, (count(*) over ())::int as matches
      from price_product p
      where p.catalog_id = c.id and p.region = q.region
        and (q.product_family = '' or p.product_family = q.product_family)
        and (q.unit = '' or p.unit = q.unit)
        and p.attributes @> q.attributes
      order by p.sku collate "C"
      limit ${CANDIDATES}
    ) m on true
    order by q.i, m.sku collate "C"`);

  const seeded = new Set<number>();
  const matches = new Map<number, Matched[]>();
  for (const row of result.rows) {
    if (row.version !== null) seeded.add(row.i);
    if (row.sku !== null) matches.set(row.i, [...(matches.get(row.i) ?? []), row]);
  }

  return queries.map((query, i): PriceAnswerResult => {
    if (!seeded.has(i)) {
      return {
        kind: "miss",
        reason: "catalog_not_seeded",
        detail: `no ${query.vendor} catalog for ${query.service} is seeded`,
      };
    }
    const found = matches.get(i) ?? [];
    const [first] = found;
    if (!first) {
      return {
        kind: "miss",
        reason: "no_match",
        detail: `no product in the ${query.vendor} ${query.service} catalog matches`,
      };
    }
    if (first.matches === 1) {
      return {
        kind: "price",
        sku: first.sku,
        unit: first.unit,
        tiers: first.tiers,
        catalogVersion: first.version,
        sourceUrl: first.source_url,
      };
    }
    return {
      kind: "ambiguous",
      candidateSkus: found.map((row) => row.sku),
      matches: first.matches,
    };
  });
}
