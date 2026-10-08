import { randomBytes } from "node:crypto";
import { open, seal } from "./aead";
import type { KeyStore } from "./keystore";

const VERSION = "v1";

export async function sealSecret(
  keys: KeyStore,
  plaintext: string,
  context: string,
): Promise<string> {
  const dataKey = randomBytes(32);
  const { keyId, wrapped } = await keys.wrap(dataKey, context);
  return [
    VERSION,
    Buffer.from(keyId, "utf8").toString("base64url"),
    wrapped.toString("base64url"),
    seal(dataKey, Buffer.from(plaintext, "utf8"), context).toString("base64url"),
  ].join(".");
}

export async function openSecret(
  keys: KeyStore,
  envelope: string,
  context: string,
): Promise<string> {
  const [version, keyId, wrapped, sealed, extra] = envelope.split(".");
  if (version !== VERSION || !keyId || !wrapped || !sealed || extra !== undefined) {
    throw new Error("not a secret envelope this console wrote");
  }
  const dataKey = await keys.unwrap(
    {
      keyId: Buffer.from(keyId, "base64url").toString("utf8"),
      wrapped: Buffer.from(wrapped, "base64url"),
    },
    context,
  );
  return open(dataKey, Buffer.from(sealed, "base64url"), context).toString("utf8");
}
