import { describe, expect, it } from "vitest";
import { targetOf } from "./providers";

describe("targetOf", () => {
  it("names the ocel provider Ocel Cloud, where the values live", () => {
    const target = targetOf("ocel");
    expect(target.label).toBe("Ocel Cloud");
    expect(target.home).toBe("Ocel Cloud");
    expect(target.own).toBe(false);
  });

  it("leaves every other provider as it was reported, in your own cloud", () => {
    expect(targetOf("aws").label).toBe("aws");
    expect(targetOf("vps").label).toBe("vps");
    expect(targetOf("aws").home).toBe("your cloud");
    expect(targetOf("aws").own).toBe(true);
    expect(targetOf(null).own).toBe(true);
  });

  it("names Ocel Cloud's edge Ocel Cloud and leaves the rest", () => {
    expect(targetOf("aws").edge("ocel-cloud")).toEqual({ kind: "ocel-cloud", label: "Ocel Cloud" });
    expect(targetOf("aws").edge("CloudFront")).toEqual({ kind: "cloudfront", label: "CloudFront" });
  });

  it("names the edge an Ocel Cloud deployment reports, none, Ocel Cloud", () => {
    expect(targetOf("ocel").edge("none")).toEqual({ kind: "ocel-cloud", label: "Ocel Cloud" });
    expect(targetOf("vps").edge("none")).toEqual({ kind: "none", label: "none" });
  });
});
