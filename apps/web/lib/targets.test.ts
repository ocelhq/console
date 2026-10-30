import { describe, expect, it } from "vitest";
import { removalWarning } from "./targets";

describe("removalWarning", () => {
  it("names the account, its recorded tiers and the projects bound to it", () => {
    const warning = removalWarning({
      vendor: "aws",
      account: "123456789012",
      region: "eu-west-1",
      tiers: [{ tier: "production" }, { tier: "preview" }],
      bound: ["shop production", "blog preview"],
    });

    expect(warning).toContain("aws 123456789012 eu-west-1");
    expect(warning).toContain("production and preview identity");
    expect(warning).toContain("shop production, blog preview");
  });

  it("says when nothing is bound or recorded", () => {
    const warning = removalWarning({
      vendor: "gcp",
      account: "my-project",
      region: "",
      tiers: [],
      bound: [],
    });

    expect(warning).toContain("gcp my-project from");
    expect(warning).toContain("no recorded tier");
    expect(warning).toContain("No project deploys to it");
  });
});
