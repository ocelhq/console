import { describe, expect, it } from "vitest";
import { callbackPath } from "./callback";

describe("callbackPath", () => {
  it("keeps a path on this console", () => {
    expect(callbackPath("/invite/abc?x=1")).toBe("/invite/abc?x=1");
  });

  it.each([undefined, "", "https://evil.example", "//evil.example", "/\\evil.example"])(
    "falls back to the root for %j",
    (redirect) => {
      expect(callbackPath(redirect)).toBe("/");
    },
  );
});
