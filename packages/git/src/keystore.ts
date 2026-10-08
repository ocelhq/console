import { createHash } from "node:crypto";
import { open, seal } from "./aead";

export interface WrappedKey {
  keyId: string;
  wrapped: Buffer;
}

export interface KeyStore {
  wrap(dataKey: Buffer, context: string): Promise<WrappedKey>;
  unwrap(key: WrappedKey, context: string): Promise<Buffer>;
}

const KEY_BYTES = 32;

export function envKeyStore(masterKey: string): KeyStore {
  const key = Buffer.from(masterKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`the console encryption key must be ${KEY_BYTES} bytes, base64 encoded`);
  }
  const keyId = `env:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

  return {
    async wrap(dataKey, context) {
      return { keyId, wrapped: seal(key, dataKey, context) };
    },
    async unwrap(wrapped, context) {
      if (wrapped.keyId !== keyId) {
        throw new Error(
          `the secret was sealed under key ${wrapped.keyId}, but CONSOLE_ENCRYPTION_KEY is ${keyId}`,
        );
      }
      return open(key, wrapped.wrapped, context);
    },
  };
}
