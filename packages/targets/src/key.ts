import {
  createPrivateKey,
  createPublicKey,
  type JsonWebKeyInput,
  type KeyObject,
  sign,
} from "node:crypto";
import type { JWK } from "jose";
import type { Signer } from "./signer";

function read(
  variable: string,
  material: string,
  as: (key: string | JsonWebKeyInput) => KeyObject,
): KeyObject {
  const trimmed = material.trim();
  let key: KeyObject;
  try {
    key = trimmed.startsWith("{")
      ? as({ key: JSON.parse(trimmed), format: "jwk" })
      : as(trimmed.replace(/\\n/g, "\n"));
  } catch {
    throw new Error(
      `${variable} is not a key: give a P-256 key as a PEM or a JWK, such as \`openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt\``,
    );
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`${variable} must be a P-256 (prime256v1) EC key, which ES256 signs with`);
  }
  return key;
}

export function keySigner(material: string): Signer {
  const key = read("CONSOLE_ISSUER_KEY", material, createPrivateKey);
  return {
    publicKey: createPublicKey(key).export({ format: "jwk" }),
    async sign(message) {
      return new Uint8Array(sign("sha256", message, { key, dsaEncoding: "ieee-p1363" }));
    },
  };
}

export function publicKeyOf(material: string): JWK {
  return read("CONSOLE_ISSUER_PREVIOUS_KEY", material, createPublicKey).export({ format: "jwk" });
}
