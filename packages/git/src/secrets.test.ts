import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { envKeyStore } from "./keystore";
import { openSecret, sealSecret } from "./secrets";

const masterKey = randomBytes(32).toString("base64");
const context = "git_app/app-1/private_key";

describe("sealSecret and openSecret", () => {
  it("round-trips a secret", async () => {
    const keys = envKeyStore(masterKey);
    const sealed = await sealSecret(keys, "-----BEGIN RSA PRIVATE KEY-----\nabc", context);
    expect(await openSecret(keys, sealed, context)).toBe("-----BEGIN RSA PRIVATE KEY-----\nabc");
  });

  it("never stores the plaintext", async () => {
    const sealed = await sealSecret(envKeyStore(masterKey), "hunter2", context);
    expect(sealed).not.toContain("hunter2");
  });

  it("seals the same secret differently each time", async () => {
    const keys = envKeyStore(masterKey);
    expect(await sealSecret(keys, "same", context)).not.toBe(
      await sealSecret(keys, "same", context),
    );
  });

  it("refuses to open under another master key", async () => {
    const sealed = await sealSecret(envKeyStore(masterKey), "hunter2", context);
    const other = envKeyStore(randomBytes(32).toString("base64"));
    await expect(openSecret(other, sealed, context)).rejects.toThrow(/key/);
  });

  it("refuses a tampered envelope", async () => {
    const keys = envKeyStore(masterKey);
    const sealed = await sealSecret(keys, "hunter2", context);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered-ciphertext-tampered").toString("base64url");
    await expect(openSecret(keys, parts.join("."), context)).rejects.toThrow();
  });

  it("refuses an envelope moved to another row or column", async () => {
    const keys = envKeyStore(masterKey);
    const sealed = await sealSecret(keys, "hunter2", "git_app/app-1/webhook_secret");
    await expect(openSecret(keys, sealed, "git_app/app-2/webhook_secret")).rejects.toThrow();
    await expect(openSecret(keys, sealed, "git_app/app-1/client_secret")).rejects.toThrow();
  });

  it("names the key it was sealed under", async () => {
    const keys = envKeyStore(masterKey);
    const sealed = await sealSecret(keys, "hunter2", context);
    const other = envKeyStore(randomBytes(32).toString("base64"));
    await expect(openSecret(other, sealed, context)).rejects.toThrow(
      /sealed under key env:[0-9a-f]{16}/,
    );
  });

  it("refuses an envelope it did not write", async () => {
    await expect(openSecret(envKeyStore(masterKey), "plain text", context)).rejects.toThrow(
      /envelope/,
    );
  });
});

describe("envKeyStore", () => {
  it("refuses a key that is not 32 bytes", () => {
    expect(() => envKeyStore(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
