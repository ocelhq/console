import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "CONSOLE_EMAIL_AUTH",
  "CONSOLE_SIGNUP",
] as const;

async function settingsWith(values: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) vi.stubEnv(key, values[key]);
  vi.resetModules();
  const { readAuthSettings } = await import("./settings");
  return readAuthSettings();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readAuthSettings", () => {
  it("defaults to invite-only sign-up with no method enabled", async () => {
    expect(await settingsWith({})).toEqual({ github: undefined, email: false, signup: "invite" });
  });

  it("enables GitHub when its group is set", async () => {
    const settings = await settingsWith({
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    });
    expect(settings.github).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("enables email and open sign-up when asked", async () => {
    const settings = await settingsWith({ CONSOLE_EMAIL_AUTH: "true", CONSOLE_SIGNUP: "open" });
    expect(settings).toMatchObject({ email: true, signup: "open" });
  });
});

describe("assertSignInMethod", () => {
  it("refuses settings with no sign-in method", async () => {
    const { assertSignInMethod } = await import("./settings");
    expect(() => assertSignInMethod({ github: undefined, email: false, signup: "open" })).toThrow(
      /No sign-in method is enabled/,
    );
  });

  it("accepts either method alone", async () => {
    const { assertSignInMethod } = await import("./settings");
    expect(() =>
      assertSignInMethod({ github: undefined, email: true, signup: "invite" }),
    ).not.toThrow();
    expect(() =>
      assertSignInMethod({
        github: { clientId: "id", clientSecret: "secret" },
        email: false,
        signup: "open",
      }),
    ).not.toThrow();
  });
});
