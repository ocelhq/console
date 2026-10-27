import { describe, expect, it } from "vitest";
import { projectHref, scopeHref, sectionOf } from "./sections";

describe("the Git Integration section", () => {
  it("is the organization's settings at /git and a project's at /projects/<slug>/git", () => {
    expect(sectionOf("/git")).toBe("git");
    expect(sectionOf("/projects/web/git")).toBe("git");
    expect(scopeHref("git")).toBe("/git");
    expect(projectHref("web", "git", "production")).toBe("/projects/web/git");
  });
});
