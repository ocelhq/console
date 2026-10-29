import type { DeploymentEstimate } from "@console/db/schema";
import { describe, expect, it } from "vitest";
import { costOf, dollars, resourceCosts } from "./estimate";

const estimate: DeploymentEstimate = {
  currency: "USD",
  profile: "moderate",
  monthlyFixed: "12.40",
  monthlyUsage: "3.10",
  resources: [
    { resource: "web", status: "priced", monthlyFixed: "12.40", monthlyUsage: "3.10" },
    { resource: "queue", status: "no-price", monthlyFixed: "", monthlyUsage: "" },
    { resource: "dns", status: "unsupported", monthlyFixed: "", monthlyUsage: "" },
    { resource: "logs", status: "free", monthlyFixed: "0", monthlyUsage: "0" },
  ],
  coverage: { supported: 2, free: 1, unsupported: 1, noPrice: 1 },
  notes: [],
};

describe("costOf", () => {
  it("names the monthly totals and the profile that priced them", () => {
    expect(costOf(estimate)).toEqual({
      line: "≈ $12.40/mo fixed + $3.10/mo usage (moderate profile)",
      unpriced: "2 resources unpriced",
    });
  });

  it("names no unpriced resources when every resource is priced or free", () => {
    expect(
      costOf({
        ...estimate,
        monthlyFixed: "0",
        monthlyUsage: "0",
        coverage: { supported: 2, free: 1, unsupported: 0, noPrice: 0 },
      }),
    ).toEqual({ line: "≈ $0.00/mo fixed + $0.00/mo usage (moderate profile)", unpriced: null });
  });

  it("counts one unpriced resource in the singular", () => {
    expect(
      costOf({
        ...estimate,
        profile: "heavy",
        monthlyFixed: "1",
        monthlyUsage: "2",
        coverage: { supported: 0, free: 0, unsupported: 0, noPrice: 1 },
      }),
    ).toEqual({
      line: "≈ $1.00/mo fixed + $2.00/mo usage (heavy profile)",
      unpriced: "1 resource unpriced",
    });
  });
});

describe("dollars", () => {
  it("formats a decimal as US dollars to the cent", () => {
    expect(dollars("1234.5")).toBe("$1,234.50");
    expect(dollars("0.004")).toBe("$0.00");
  });

  it("formats nothing for an amount the estimate left out", () => {
    expect(dollars("")).toBe("—");
  });
});

describe("resourceCosts", () => {
  it("lists each resource with its status and monthly amounts", () => {
    expect(resourceCosts(estimate)).toEqual([
      { resource: "web", status: "priced", fixed: "$12.40", usage: "$3.10" },
      { resource: "queue", status: "no-price", fixed: "—", usage: "—" },
      { resource: "dns", status: "unsupported", fixed: "—", usage: "—" },
      { resource: "logs", status: "free", fixed: "$0.00", usage: "$0.00" },
    ]);
  });
});
