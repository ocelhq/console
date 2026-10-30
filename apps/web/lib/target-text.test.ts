import { describe, expect, it } from "vitest";
import { noTierNote, removalWarning, targetLabel } from "./target-text";

describe("noTierNote", () => {
  it("says bootstrap stopped short only for a target that never recorded a tier", () => {
    expect(noTierNote(null)).toMatch(/^No tier recorded yet: bootstrap stopped/);
  });

  it("says the identities were removed for a target whose tiers were forgotten", () => {
    const note = noTierNote("2026-10-29T06:31:00.000Z");
    expect(note).toMatch(/removed/);
    expect(note).not.toMatch(/stopped before/);
  });
});

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
      vendor: "vps",
      account: "box.example.com",
      region: "",
      tiers: [],
      bound: [],
    });

    expect(warning).toContain("vps box.example.com from");
    expect(warning).toContain("no recorded tier");
    expect(warning).toContain("No project deploys to it");
  });
});

describe("targetLabel", () => {
  it("names a target's namespace when it is not the default, so two in one account differ", () => {
    const at = { vendor: "aws", account: "123456789012", region: "eu-west-1" };
    expect(targetLabel({ ...at, namespace: "ocel" })).toBe("aws 123456789012 eu-west-1");
    expect(targetLabel({ ...at, namespace: "staging" })).toBe(
      "aws 123456789012 eu-west-1 (staging)",
    );
    expect(targetLabel({ ...at, namespace: "" })).toBe("aws 123456789012 eu-west-1");
  });
});
