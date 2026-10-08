import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "CONSOLE_ENCRYPTION_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;

async function settingsWith(values: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) vi.stubEnv(key, values[key]);
  vi.resetModules();
  const { readGitSettings } = await import("./settings");
  return readGitSettings();
}

const app = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "ocel-console",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: "whsec",
  GITHUB_APP_CLIENT_ID: "Iv1.x",
  GITHUB_APP_CLIENT_SECRET: "secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readGitSettings", () => {
  it("has no key and no system app by default", async () => {
    expect(await settingsWith({})).toEqual({ encryptionKey: undefined, githubApp: undefined });
  });

  it("reads the encryption key", async () => {
    const key = randomBytes(32).toString("base64");
    expect((await settingsWith({ CONSOLE_ENCRYPTION_KEY: key })).encryptionKey).toBe(key);
  });

  it("reads a system GitHub app once its whole group is set", async () => {
    const settings = await settingsWith(app);
    expect(settings.githubApp).toEqual({
      appId: "123",
      slug: "ocel-console",
      privateKey: "pem",
      webhookSecret: "whsec",
      clientId: "Iv1.x",
      clientSecret: "secret",
    });
  });

  it("restores a private key whose newlines the environment flattened to spaces", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs1",
      format: "pem",
    }) as string;
    const settings = await settingsWith({
      ...app,
      GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, " "),
    });
    expect(settings.githubApp?.privateKey).toBe(pem);
  });
});
