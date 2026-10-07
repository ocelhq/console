import path from "node:path";
import { CONNECT_PREFIX } from "@console/api";
import { describe, expect, it } from "vitest";

describe("the Connect route", () => {
  it("lives at the path prefix connect strips", () => {
    expect(import.meta.dirname.endsWith(path.join("app", CONNECT_PREFIX, "[...path]"))).toBe(true);
  });
});
