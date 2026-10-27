import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import type { JWK } from "jose";
import type { Signer } from "./signer";

function keyObject(material: string, read: typeof createPrivateKey): KeyObject {
  const trimmed = material.trim();
  try {
    return trimmed.startsWith("{")
      ? read({ key: JSON.parse(trimmed), format: "jwk" })
      : read(trimmed.replace(/\\n/g, "\n"));
  } catch {
    throw new Error(
      "CONSOLE_ISSUER_KEY is not a key: give a P-256 private key as a PEM or a JWK, such as `openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt`",
    );
  }
}

function p256(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("The issuer key must be a P-256 (prime256v1) EC key, which ES256 signs with");
  }
  return key;
}

function publicJwk(key: KeyObject): JWK {
  const half = key.type === "public" ? key : createPublicKey(key);
  return half.export({ format: "jwk" }) as JWK;
}

export function keySigner(material: string): Signer {
  const key = p256(keyObject(material, createPrivateKey));
  return {
    publicKey: publicJwk(key),
    async sign(message) {
      return new Uint8Array(sign("sha256", message, { key, dsaEncoding: "ieee-p1363" }));
    },
  };
}

export function publicKeyOf(material: string): JWK {
  let key: KeyObject;
  try {
    key = keyObject(material, createPrivateKey);
  } catch {
    key = keyObject(material, createPublicKey as typeof createPrivateKey);
  }
  return publicJwk(p256(key));
}
