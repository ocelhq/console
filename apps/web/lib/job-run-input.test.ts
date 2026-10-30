import type { NeededVariable } from "@console/api";
import { describe, expect, it } from "vitest";
import {
  answerOf,
  blankFields,
  fieldKey,
  folderLabel,
  isMultiline,
  pasteInto,
  sectionsOf,
  spansFolders,
  tierHeading,
} from "./job-run-input";

function needed(key: string, overrides: Partial<NeededVariable> = {}): NeededVariable {
  return {
    key,
    folder: "",
    secret: false,
    description: "",
    reason: "no value",
    group: "",
    ...overrides,
  };
}

describe("sectionsOf", () => {
  it("puts ungrouped variables first, then each group with its description", () => {
    const sections = sectionsOf({
      variables: [
        needed("STRIPE_KEY", { group: "stripe" }),
        needed("DATABASE_URL"),
        needed("STRIPE_WEBHOOK", { group: "stripe" }),
        needed("SENTRY_DSN", { group: "sentry" }),
      ],
      groups: [{ key: "stripe", description: "Payments through Stripe" }],
    });

    expect(
      sections.map((section) => ({
        group: section.group,
        description: section.description,
        keys: section.folders.flatMap((folder) => folder.variables.map((v) => v.key)),
      })),
    ).toEqual([
      { group: "", description: "", keys: ["DATABASE_URL"] },
      {
        group: "stripe",
        description: "Payments through Stripe",
        keys: ["STRIPE_KEY", "STRIPE_WEBHOOK"],
      },
      { group: "sentry", description: "", keys: ["SENTRY_DSN"] },
    ]);
  });

  it("splits a section by folder, the project root first", () => {
    const [section] = sectionsOf({
      variables: [
        needed("API_URL", { folder: "/apps/web" }),
        needed("DATABASE_URL"),
        needed("QUEUE", { folder: "/apps/api" }),
        needed("TOKEN", { folder: "/apps/web" }),
      ],
      groups: [],
    });

    expect(
      section.folders.map((folder) => [folder.folder, folder.variables.map((v) => v.key)]),
    ).toEqual([
      ["", ["DATABASE_URL"]],
      ["/apps/api", ["QUEUE"]],
      ["/apps/web", ["API_URL", "TOKEN"]],
    ]);
  });
});

describe("spansFolders", () => {
  it("is true only when the variables live in more than one folder", () => {
    expect(spansFolders([needed("A"), needed("B")])).toBe(false);
    expect(spansFolders([needed("A"), needed("B", { folder: "/apps/web" })])).toBe(true);
  });
});

describe("labels", () => {
  it("names the project root and drops a folder's leading slash", () => {
    expect(folderLabel("")).toBe("Project root");
    expect(folderLabel("/apps/web")).toBe("apps/web");
  });

  it("heads the form with the tier the values are for", () => {
    expect(tierHeading("production")).toBe("Production values");
    expect(tierHeading("preview")).toBe("Preview values");
    expect(tierHeading(null)).toBe("Values");
  });

  it("keeps the same key apart in two folders", () => {
    expect(fieldKey(needed("A"))).not.toBe(fieldKey(needed("A", { folder: "/apps/web" })));
  });
});

describe("blankFields and answerOf", () => {
  const variables = [needed("A"), needed("B", { folder: "/apps/web" }), needed("C")];

  it("finds the variables still without a value, whitespace counting as none", () => {
    const typed = new Map([
      [fieldKey(variables[0]), "set"],
      [fieldKey(variables[2]), "  \n"],
    ]);
    expect(blankFields(variables, typed).map((v) => v.key)).toEqual(["B", "C"]);
  });

  it("answers every variable with exactly what was typed", () => {
    const typed = new Map([
      [fieldKey(variables[0]), " padded "],
      [fieldKey(variables[1]), "line one\nline two"],
      [fieldKey(variables[2]), "c"],
    ]);
    expect(answerOf(variables, typed)).toEqual([
      { key: "A", folder: "", value: " padded " },
      { key: "B", folder: "/apps/web", value: "line one\nline two" },
      { key: "C", folder: "", value: "c" },
    ]);
  });
});

describe("pasteInto", () => {
  it("replaces the selection with what was pasted, keeping its line breaks", () => {
    expect(pasteInto("abcd", "X\nY", 1, 3)).toBe("aX\nYd");
    expect(pasteInto("ab", "-----BEGIN\nKEY", null, null)).toBe("ab-----BEGIN\nKEY");
  });

  it("tells a value over several lines", () => {
    expect(isMultiline("a\nb")).toBe(true);
    expect(isMultiline("a\r\nb")).toBe(true);
    expect(isMultiline("ab")).toBe(false);
  });
});
