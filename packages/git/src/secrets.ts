import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyStore } from "./keystore";

const VERSION = "v1";
const IV_BYTES = 12;

export async function sealSecret(keys: KeyStore, plaintext: string): Promise<string> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const wrapped = await keys.wrap(dataKey);
  return [
    VERSION,
    Buffer.from(wrapped).toString("base64url"),
    iv.toString("base64url"),
    Buffer.concat([sealed, cipher.getAuthTag()]).toString("base64url"),
  ].join(".");
}

export async function openSecret(keys: KeyStore, envelope: string): Promise<string> {
  const [version, wrapped, iv, body] = envelope.split(".");
  if (version !== VERSION || !wrapped || !iv || !body) {
    throw new Error("not a secret envelope this console wrote");
  }
  const dataKey = await keys.unwrap(Buffer.from(wrapped, "base64url").toString());
  const bytes = Buffer.from(body, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(iv, "base64url"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}
