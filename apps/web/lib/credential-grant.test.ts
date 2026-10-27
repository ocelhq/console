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
        preview: { enabled: true, branches: "*" },
      }),
    ).toEqual({
      ok: true,
      grant: {
        production: { branches: ["main", "release/*"], environment: "production" },
        preview: { branches: ["*"] },
      },
    });
  });

  it.each(["", " ", ",", ", ,"])(
    "refuses production credentials for branches %j, rather than every branch",
    (branches) => {
      const answer = credentialGrantOf({
        ...off,
        production: { enabled: true, branches, environment: "" },
      });

      expect(answer).toEqual({ ok: false, message: expect.stringContaining("production") });
    },
  );

  it("refuses preview credentials for no branch named", () => {
    expect(credentialGrantOf({ ...off, preview: { enabled: true, branches: " , " } }).ok).toBe(
      false,
    );
  });

  it("takes every branch only when * is named", () => {
    expect(
      credentialGrantOf({ ...off, production: { enabled: true, branches: "*", environment: "" } }),
    ).toEqual({ ok: true, grant: { production: { branches: ["*"] } } });
  });
});
