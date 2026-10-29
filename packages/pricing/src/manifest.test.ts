import { describe, expect, it } from "vitest";
import { keepsProduct, manifestEntry, parseManifest } from "./manifest";

const manifest = parseManifest({
  format: 1,
  currency: "USD",
  vendors: [
    {
      vendor: "aws",
      source: "aws-offers",
      services: [
        {
          service: "AmazonEC2",
          regions: [],
          productFamilies: ["Compute Instance", "NAT Gateway"],
          where: [
            { attribute: "tenancy", in: ["Shared"], productFamilies: ["Compute Instance"] },
            { attribute: "preInstalledSw", in: ["NA"], productFamilies: ["Compute Instance"] },
          ],
          exclude: [{ attribute: "locationType", in: ["AWS Local Zone"] }],
        },
      ],
    },
    {
      vendor: "cloudflare",
      source: "static",
      services: [{ service: "workers", file: "static/cloudflare.json" }],
    },
  ],
});

describe("keepsProduct", () => {
  const ec2 = manifestEntry(manifest, "aws", "AmazonEC2");
  const instance = { tenancy: "Shared", preInstalledSw: "NA", locationType: "AWS Region" };

  it("keeps a product of a named family that every filter for its family passes", () => {
    expect(keepsProduct(ec2, "Compute Instance", instance)).toBe(true);
  });

  it("drops a family the service does not name", () => {
    expect(keepsProduct(ec2, "Storage", instance)).toBe(false);
  });

  it("drops a product whose attribute is outside a where filter, reading a missing one as empty", () => {
    expect(keepsProduct(ec2, "Compute Instance", { ...instance, tenancy: "Dedicated" })).toBe(
      false,
    );
    expect(keepsProduct(ec2, "Compute Instance", { preInstalledSw: "NA" })).toBe(false);
  });

  it("applies a filter only to the families it names", () => {
    expect(keepsProduct(ec2, "NAT Gateway", { locationType: "AWS Region" })).toBe(true);
  });

  it("drops what an exclude filter matches, in every family when it names none", () => {
    expect(keepsProduct(ec2, "NAT Gateway", { locationType: "AWS Local Zone" })).toBe(false);
  });
});

describe("parseManifest", () => {
  it("flattens each service into an entry, reads absent lists as empty, and records a sha256", () => {
    expect(manifest.entries).toHaveLength(2);
    expect(manifestEntry(manifest, "cloudflare", "workers")).toEqual({
      vendor: "cloudflare",
      source: "static",
      service: "workers",
      regions: [],
      productFamilies: [],
      where: [],
      exclude: [],
      file: "static/cloudflare.json",
    });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["an unknown format", { format: 2, currency: "USD", vendors: [] }, /format/],
    [
      "an unknown source",
      { format: 1, currency: "USD", vendors: [{ vendor: "x", source: "ftp", services: [] }] },
      /source/,
    ],
    [
      "a static service without a file",
      {
        format: 1,
        currency: "USD",
        vendors: [{ vendor: "x", source: "static", services: [{ service: "s" }] }],
      },
      /file/,
    ],
    [
      "a file on a service that is not static",
      {
        format: 1,
        currency: "USD",
        vendors: [{ vendor: "x", source: "aws-offers", services: [{ service: "s", file: "f" }] }],
      },
      /file/,
    ],
  ])("refuses %s", (_, raw, message) => {
    expect(() => parseManifest(raw)).toThrow(message);
  });

  it("refuses a lookup of a service the manifest does not name", () => {
    expect(() => manifestEntry(manifest, "aws", "AWSLambda")).toThrow(
      /names no aws service AWSLambda/,
    );
  });
});
