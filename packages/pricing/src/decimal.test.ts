import { describe, expect, it } from "vitest";
import { canonicalDecimal, compareDecimals, isCanonicalDecimal, unitsAndNanos } from "./decimal";

describe("canonicalDecimal", () => {
  it.each([
    ["0.0000002000", "0.0000002"],
    ["0.0000000000", "0"],
    ["0", "0"],
    ["10240", "10240"],
    ["007.50", "7.5"],
    ["1.5E-7", "0.00000015"],
    ["2e3", "2000"],
    [180000, "180000"],
    [1e-7, "0.0000001"],
    [0.5, "0.5"],
  ])("writes %j as %j", (input, canonical) => {
    expect(canonicalDecimal(input)).toBe(canonical);
    expect(isCanonicalDecimal(canonical)).toBe(true);
  });

  it.each(["-1", "Inf", "", "1.", ".5", "0x10"])("refuses %j", (input) => {
    expect(() => canonicalDecimal(input)).toThrow(/not a non-negative decimal/);
  });

  it("knows a non-canonical decimal", () => {
    expect(isCanonicalDecimal("0.10")).toBe(false);
    expect(isCanonicalDecimal("01")).toBe(false);
    expect(isCanonicalDecimal("1e3")).toBe(false);
  });
});

describe("compareDecimals", () => {
  it("orders by value, not by text", () => {
    const sorted = ["153600", "0", "51200", "10240", "0.5", "9.99"].sort(compareDecimals);
    expect(sorted).toEqual(["0", "0.5", "9.99", "10240", "51200", "153600"]);
    expect(compareDecimals("1.50", "1.5")).toBe(0);
  });
});

describe("unitsAndNanos", () => {
  it("joins a GCP money value exactly", () => {
    expect(unitsAndNanos("0", 2000)).toBe("0.000002");
    expect(unitsAndNanos("3", 500_000_000)).toBe("3.5");
    expect(unitsAndNanos("12", 0)).toBe("12");
  });
});
