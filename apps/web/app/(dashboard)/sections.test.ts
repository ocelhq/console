import { describe, expect, it } from "vitest";
import { projectHref, projectPage, scopeHref, sectionOf } from "./sections";

describe("the Git Integration section", () => {
  it("is the organization's settings at /git and a project's at /projects/<slug>/git", () => {
    expect(sectionOf("/git")).toBe("git");
    expect(sectionOf("/projects/web/git")).toBe("git");
    expect(scopeHref("git")).toBe("/git");
    expect(projectHref("web", "git", "production")).toBe("/projects/web/git");
  });

  it("has a page of its own, so the generic notice pages never render it", () => {
    expect(projectPage("git")).toBeUndefined();
    expect(projectPage("domains")?.empty).toBeTruthy();
  });
});

describe("the Targets section", () => {
  it("is the organization's targets at /targets and a project's bindings at /projects/<slug>/targets", () => {
    expect(sectionOf("/targets")).toBe("targets");
    expect(sectionOf("/projects/web/targets")).toBe("targets");
    expect(scopeHref("targets")).toBe("/targets");
    expect(projectHref("web", "targets", "preview")).toBe("/projects/web/targets?env=preview");
    expect(projectPage("targets")).toBeUndefined();
  });
});
