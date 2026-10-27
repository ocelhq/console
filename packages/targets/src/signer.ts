import { calculateJwkThumbprint, type JWK } from "jose";

export interface Signer {
  publicKey: JWK;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface PublishedKey extends JWK {
  kid: string;
  alg: "ES256";
  use: "sig";
}

export async function published(publicKey: JWK): Promise<PublishedKey> {
  const { kty, crv, x, y } = publicKey;
  const key = { kty, crv, x, y };
  return { ...key, kid: await calculateJwkThumbprint(key), alg: "ES256", use: "sig" };
}

function integer(der: Uint8Array, at: number): { value: Uint8Array; next: number } {
  const length = der[at + 1];
  if (der[at] !== 0x02 || length === undefined || length > 33 || at + 2 + length > der.length) {
    throw new Error("the signature is not a DER ECDSA signature");
  }
  let value = der.subarray(at + 2, at + 2 + length);
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) throw new Error("the signature is not a P-256 signature");
  return { value, next: at + 2 + length };
}

export function joseSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30 || der[1] === undefined || der[1] + 2 !== der.length) {
    throw new Error("the signature is not a DER ECDSA signature");
  }
  const r = integer(der, 2);
  const s = integer(der, r.next);
  if (s.next !== der.length) throw new Error("the signature is not a DER ECDSA signature");
  const jose = new Uint8Array(64);
  jose.set(r.value, 32 - r.value.length);
  jose.set(s.value, 64 - s.value.length);
  return jose;
}
