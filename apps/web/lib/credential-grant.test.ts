import { describe, expect, it } from "vitest";
import { credentialGrantOf, type GrantInput } from "./credential-grant";

const off: GrantInput = {
  production: { enabled: false, branches: "", environment: "" },
  preview: { enabled: false, branches: "" },
};

describe("credentialGrantOf", () => {
  it("grants nothing with both tiers off", () => {
    expect(credentialGrantOf(off)).toEqual({ ok: true, grant: {} });
  });

  it("reads each tier's branches as patterns and the production environment when named", () => {
    expect(
      credentialGrantOf({
        production: { enabled: true, branches: "main, release/*", environment: " production " },
        preview: { enabled: true, branches: "" },
      }),
    ).toEqual({
      ok: true,
      grant: {
        production: { branches: ["main", "release/*"], environment: "production" },
        preview: { branches: ["*"] },
      },
    });
  });

  it("refuses production credentials for no branch named, rather than every branch", () => {
    const answer = credentialGrantOf({
      ...off,
      production: { enabled: true, branches: " ", environment: "" },
    });

    expect(answer).toEqual({ ok: false, message: expect.stringContaining("production") });
  });

  it("gives a linked pipeline's production the project's production branch, whatever was typed", () => {
    expect(
      credentialGrantOf(
        { ...off, production: { enabled: true, branches: "*", environment: "" } },
        "trunk",
      ),
    ).toEqual({ ok: true, grant: { production: { branches: ["trunk"] } } });
  });
});
