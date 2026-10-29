import { createHash } from "node:crypto";
import { z } from "zod";

const names = z.array(z.string().min(1)).default([]);

const filter = z.object({
  attribute: z.string().min(1),
  in: z.array(z.string()),
  productFamilies: names,
});

const service = z.object({
  service: z.string().min(1),
  regions: names,
  productFamilies: names,
  where: z.array(filter).default([]),
  exclude: z.array(filter).default([]),
});

const fetched = (source: "aws-offers" | "gcp-catalog") =>
  z.object({
    vendor: z.string().min(1),
    source: z.literal(source),
    services: z.array(service.strict()),
  });

const manifest = z.object({
  format: z.literal(1),
  currency: z.literal("USD"),
  vendors: z.array(
    z.discriminatedUnion("source", [
      fetched("aws-offers"),
      fetched("gcp-catalog"),
      z.object({
        vendor: z.string().min(1),
        source: z.literal("static"),
        services: z.array(service.extend({ file: z.string().min(1) }).strict()),
      }),
    ]),
  ),
});

export type ManifestFilter = z.infer<typeof filter>;

export type ManifestEntry = z.infer<typeof service> & { vendor: string } & (
    | { source: "aws-offers" | "gcp-catalog" }
    | { source: "static"; file: string }
  );

export type IngestSource = ManifestEntry["source"];

export type Manifest = { sha256: string; entries: ManifestEntry[] };

export function parseManifest(raw: unknown): Manifest {
  const parsed = manifest.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the ingest manifest is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    entries: parsed.data.vendors.flatMap(({ vendor, source, services }): ManifestEntry[] =>
      source === "static"
        ? services.map((entry) => ({ ...entry, vendor, source }))
        : services.map((entry) => ({ ...entry, vendor, source })),
    ),
  };
}

export function manifestEntry(manifest: Manifest, vendor: string, service: string): ManifestEntry {
  const entry = manifest.entries.find(
    (candidate) => candidate.vendor === vendor && candidate.service === service,
  );
  if (!entry) throw new Error(`the ingest manifest names no ${vendor} service ${service}`);
  return entry;
}

export function keepsProduct(
  entry: ManifestEntry,
  family: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  if (entry.productFamilies.length > 0 && !entry.productFamilies.includes(family)) return false;
  const applies = (filter: ManifestFilter) =>
    filter.productFamilies.length === 0 || filter.productFamilies.includes(family);
  const value = (filter: ManifestFilter) => {
    const found = attributes[filter.attribute];
    return typeof found === "string" ? found : "";
  };
  for (const filter of entry.where) {
    if (applies(filter) && !filter.in.includes(value(filter))) return false;
  }
  for (const filter of entry.exclude) {
    if (applies(filter) && filter.in.includes(value(filter))) return false;
  }
  return true;
}
