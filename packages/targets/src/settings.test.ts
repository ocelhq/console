import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "CONSOLE_ISSUER_KMS_KEY_ID",
  "CONSOLE_ISSUER_KEY",
  "CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID",
  "CONSOLE_ISSUER_PREVIOUS_KEY",
] as const;

async function settingsWith(values: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) vi.stubEnv(key, values[key]);
  vi.resetModules();
  const { readIssuerSettings } = await import("./settings");
  return readIssuerSettings();
}

const pem = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readIssuerSettings", () => {
  it("is unset with neither a KMS key nor a key", async () => {
    expect(await settingsWith({})).toBeUndefined();
    expect(await settingsWith({ CONSOLE_ISSUER_PREVIOUS_KEY: pem() })).toBeUndefined();
  });

  it("signs with the key from the env", async () => {
    const key = pem();

    expect(await settingsWith({ CONSOLE_ISSUER_KEY: key })).toEqual({
      current: { kind: "key", key },
      previous: [],
    });
  });

  it("signs with the KMS key when both are set, and publishes both previous keys", async () => {
    const key = pem();
    const old = pem();

    expect(
      await settingsWith({
        CONSOLE_ISSUER_KMS_KEY_ID: "alias/console-issuer",
        CONSOLE_ISSUER_KEY: key,
        CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID: "alias/old",
        CONSOLE_ISSUER_PREVIOUS_KEY: old,
      }),
    ).toEqual({
      current: { kind: "kms", keyId: "alias/console-issuer" },
      previous: [
        { kind: "kms", keyId: "alias/old" },
        { kind: "key", key: old },
      ],
    });
  });
});
