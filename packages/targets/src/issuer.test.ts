import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createIssuer } from "./issuer";
import { keySigner, publicKeyOf } from "./key";
import { type KmsKeys, kmsPublicKey, kmsSigner } from "./kms";
import { joseSignature } from "./signer";

const ORIGIN = "https://console.example.com";

function p256() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

function pem() {
  return p256().privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function fakeKms(): KmsKeys & { calls: string[] } {
  const keys = new Map<string, ReturnType<typeof p256>>();
  const calls: string[] = [];
  const of = (keyId: string) => {
    let pair = keys.get(keyId);
    if (!pair) {
      pair = p256();
      keys.set(keyId, pair);
    }
    return pair;
  };
  return {
    calls,
    async publicKey(keyId) {
      calls.push(`GetPublicKey ${keyId}`);
      return new Uint8Array(of(keyId).publicKey.export({ format: "der", type: "spki" }));
    },
    async sign(keyId, message) {
      calls.push(`Sign ${keyId}`);
      return new Uint8Array(
        sign("sha256", message, { key: of(keyId).privateKey, dsaEncoding: "der" }),
      );
    },
  };
}

async function verified(issuer: Awaited<ReturnType<typeof createIssuer>>, token: string) {
  return jwtVerify(token, createLocalJWKSet(await issuer.jwks()), {
    issuer: `${ORIGIN}/oidc`,
    audience: "ocel-target:t",
    algorithms: ["ES256"],
  });
}

describe("an issuer signing with a P-256 key from the env", () => {
  it("mints ES256 tokens its own JWKS verifies, with the kid the key's thumbprint", async () => {
    const material = pem();
    const issuer = createIssuer(ORIGIN, { signer: keySigner(material), previous: [] });

    const token = await issuer.mint({ aud: "ocel-target:t", sub: "s", exp: 2_000_000_000 });

    const { payload, protectedHeader } = await verified(issuer, token);
    expect(payload).toMatchObject({ iss: `${ORIGIN}/oidc`, sub: "s" });
    expect(protectedHeader).toMatchObject({ alg: "ES256", typ: "JWT" });
    const jwk = createPublicKey(createPrivateKey(material)).export({ format: "jwk" });
    expect(protectedHeader.kid).toBe(await calculateJwkThumbprint(jwk as never));
  });

  it("takes the key as a JWK too", async () => {
    const jwk = p256().privateKey.export({ format: "jwk" });
    const issuer = createIssuer(ORIGIN, {
      signer: keySigner(JSON.stringify(jwk)),
      previous: [],
    });

    await expect(
      verified(issuer, await issuer.mint({ aud: "ocel-target:t", exp: 2_000_000_000 })),
    ).resolves.toBeDefined();
  });

  it("takes a SEC1 PEM", async () => {
    const material = p256().privateKey.export({ format: "pem", type: "sec1" }).toString();

    expect(() => keySigner(material)).not.toThrow();
  });

  it.each([
    ["a P-384 key", () => generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey],
    ["an RSA key", () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey],
  ])("refuses %s, naming the curve it needs", (_, key) => {
    const material = key().export({ format: "pem", type: "pkcs8" }).toString();

    expect(() => keySigner(material)).toThrow(/P-256/);
  });

  it("refuses something that is no key", () => {
    expect(() => keySigner("not a key")).toThrow(/CONSOLE_ISSUER_KEY/);
  });
});

describe("an issuer rotating its key", () => {
  it("publishes the previous key beside the current one and signs only with the current", async () => {
    const current = pem();
    const previous = pem();
    const issuer = createIssuer(ORIGIN, {
      signer: keySigner(current),
      previous: [publicKeyOf(previous)],
    });

    const keys = (await issuer.jwks()).keys;
    const token = await issuer.mint({ aud: "ocel-target:t", exp: 2_000_000_000 });

    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.alg === "ES256" && key.use === "sig" && !("d" in key))).toBe(
      true,
    );
    expect(decodeProtectedHeader(token).kid).toBe(keys[0]?.kid);
    expect(keys[1]?.kid).not.toBe(keys[0]?.kid);
  });

  it("publishes a previous key given only as its public half", async () => {
    const previous = createPublicKey(createPrivateKey(pem()))
      .export({ format: "pem", type: "spki" })
      .toString();

    expect(publicKeyOf(previous).kty).toBe("EC");
  });
});

describe("an issuer signing with a KMS key", () => {
  it("mints tokens its JWKS verifies, from the key's public half and DER signatures", async () => {
    const kms = fakeKms();
    const issuer = createIssuer(ORIGIN, {
      signer: await kmsSigner("alias/issuer", kms),
      previous: [await kmsPublicKey("alias/old", kms)],
    });

    for (let i = 0; i < 20; i++) {
      const token = await issuer.mint({ aud: "ocel-target:t", exp: 2_000_000_000, n: i });
      await expect(verified(issuer, token)).resolves.toBeDefined();
    }
    expect(kms.calls.filter((call) => call.startsWith("Sign"))).toEqual(
      Array(20).fill("Sign alias/issuer"),
    );
  });
});

describe("joseSignature", () => {
  it("turns any DER ECDSA signature into the 64-byte r‖s node verifies as ieee-p1363", () => {
    const { privateKey, publicKey } = p256();
    for (let i = 0; i < 200; i++) {
      const data = Buffer.from(`message ${i}`);
      const der = sign("sha256", data, { key: privateKey, dsaEncoding: "der" });

      const jose = joseSignature(new Uint8Array(der));

      expect(jose).toHaveLength(64);
      expect(
        verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jose)),
      ).toBe(true);
    }
  });

  it("left-pads a short integer and drops the sign byte of a high one", () => {
    const high = Array(32).fill(0xff);
    const der = new Uint8Array([0x30, 0x26, 0x02, 0x01, 0x07, 0x02, 0x21, 0x00, ...high]);

    const jose = joseSignature(der);

    expect([...jose.subarray(0, 32)]).toEqual([...Array(31).fill(0), 0x07]);
    expect([...jose.subarray(32)]).toEqual(high);
  });

  it("refuses bytes that are no DER signature", () => {
    expect(() => joseSignature(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
