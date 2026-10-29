import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStaticCatalog } from "./static";

function catalog(products: unknown[], over: Record<string, unknown> = {}) {
  return {
    format: 1,
    vendor: "cloudflare",
    version: "2026-09-13",
    currency: "USD",
    products,
    ...over,
  };
}

const workers = {
  service: "workers",
  sku: "workers-requests",
  region: "",
  productFamily: "Workers",
  attributes: { plan: "paid", metric: "requests" },
  purchaseOption: "on_demand",
  unit: "requests",
  tiers: [
    { start: "0", price: "0" },
    { start: "10000000", price: "0.00000030" },
  ],
  source: "https://developers.cloudflare.com/workers/platform/pricing/",
  verified: "2026-09-13",
};

describe("parseStaticCatalog", () => {
  it("versions the catalog by its version and the file's sha256, and canonicalizes its prices", () => {
    const raw = catalog([workers]);
    const digest = createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 12);
    expect(parseStaticCatalog("static/cloudflare.json", raw)).toEqual({
      vendor: "cloudflare",
      version: `2026-09-13-${digest}`,
      products: [
        {
          service: "workers",
          sku: "workers-requests",
          region: "",
          productFamily: "Workers",
          unit: "requests",
          attributes: { plan: "paid", metric: "requests" },
          tiers: [
            { start: "0", price: "0" },
            { start: "10000000", price: "0.0000003" },
          ],
          sourceUrl: "https://developers.cloudflare.com/workers/platform/pricing/",
        },
      ],
    });
  });

  it.each([
    ["an unknown format", catalog([workers], { format: 2 }), /format/],
    [
      "a negative price",
      catalog([{ ...workers, tiers: [{ start: "0", price: "-1" }] }]),
      /not a non-negative decimal/,
    ],
    ["an unknown field", catalog([{ ...workers, price: "1" }]), /price/],
    [
      "a purchase option other than on_demand",
      catalog([{ ...workers, purchaseOption: "reserved" }]),
      /purchaseOption/,
    ],
    ["no source", catalog([{ ...workers, source: "" }]), /source/],
    ["no verified date", catalog([{ ...workers, verified: undefined }]), /verified/],
  ])("refuses %s, naming the file", (_, raw, message) => {
    expect(() => parseStaticCatalog("static/cloudflare.json", raw)).toThrow(message);
    expect(() => parseStaticCatalog("static/cloudflare.json", raw)).toThrow(
      /^static\/cloudflare\.json: /,
    );
  });
});
