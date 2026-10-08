import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { envKeyStore } from "./keystore";
import { openSecret, sealSecret } from "./secrets";

const masterKey = randomBytes(32).toString("base64");

describe("sealSecret and openSecret", () => {
  it("round-trips a secret", async () => {
    const keys = envKeyStore(masterKey);
    const sealed = await sealSecret(keys, "-----BEGIN RSA PRIVATE KEY-----\nabc");
    expect(await openSecret(keys, sealed)).toBe("-----BEGIN RSA PRIVATE KEY-----\nabc");
  });

  it("never stores the plaintext", async () => {
    const sealed = await sealSecret(envKeyStore(masterKey), "hunter2");
    expect(sealed).not.toContain("hunter2");
  });

  it("seals the same secret differently each time", async () => {
    const keys = envKeyStore(masterKey);
    expect(await sealSecret(keys, "same")).not.toBe(await sealSecret(keys, "same"));
  });

  it("refuses to open under another master key", async () => {
    const sealed = await sealSecret(envKeyStore(masterKey), "hunter2");
    const other = envKeyStore(randomBytes(32).toString("base64"));
    await expect(openSecret(other, sealed)).rejects.toThrow();
  });

  it("refuses a tampered envelope", async () => {
    const keys = envKeyStore(masterKey);
    const sealed = await sealSecret(keys, "hunter2");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    await expect(openSecret(keys, parts.join("."))).rejects.toThrow();
  });

  it("refuses an envelope it did not write", async () => {
    await expect(openSecret(envKeyStore(masterKey), "plain text")).rejects.toThrow(/envelope/);
  });
});

describe("envKeyStore", () => {
  it("refuses a key that is not 32 bytes", () => {
    expect(() => envKeyStore(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
