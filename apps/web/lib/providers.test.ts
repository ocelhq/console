import { describe, expect, it } from "vitest";
import { connectorLabel, edgeLabel, isOcelCloud, providerLabel } from "./providers";

describe("providerLabel", () => {
  it("names the ocel provider Ocel Cloud", () => {
    expect(providerLabel("ocel")).toBe("Ocel Cloud");
    expect(isOcelCloud("ocel")).toBe(true);
  });

  it("leaves every other provider as it was reported", () => {
    expect(providerLabel("aws")).toBe("aws");
    expect(providerLabel("vps")).toBe("vps");
    expect(isOcelCloud("aws")).toBe(false);
    expect(isOcelCloud(null)).toBe(false);
  });

  it("names Ocel Cloud's edge Ocel Cloud and leaves the rest", () => {
    expect(edgeLabel("ocel-cloud")).toBe("Ocel Cloud");
    expect(edgeLabel("cloudfront")).toBe("cloudfront");
  });

  it("names the edge an Ocel Cloud deployment reports, none, Ocel Cloud", () => {
    expect(edgeLabel("none", "ocel")).toBe("Ocel Cloud");
    expect(edgeLabel("none", "vps")).toBe("none");
    expect(edgeLabel("none")).toBe("none");
  });
});

describe("connectorLabel", () => {
  it("names the ocel vendor's connector Ocel Cloud rather than its target", () => {
    expect(connectorLabel({ vendor: "ocel", target: "ocel/cloud" })).toBe("Ocel Cloud");
  });

  it("names any other connector by its target", () => {
    expect(connectorLabel({ vendor: "vps", target: "vps/sha256:abc/ocel" })).toBe(
      "vps/sha256:abc/ocel",
    );
  });
});
