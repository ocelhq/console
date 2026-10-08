import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface KeyStore {
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

export function envKeyStore(masterKey: string): KeyStore {
  const key = Buffer.from(masterKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`the console encryption key must be ${KEY_BYTES} bytes, base64 encoded`);
  }

  return {
    async wrap(dataKey) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return [iv, sealed, cipher.getAuthTag()].map((part) => part.toString("base64")).join(".");
    },
    async unwrap(wrapped) {
      const [iv, sealed, tag] = wrapped.split(".").map((part) => Buffer.from(part, "base64"));
      if (!iv || !sealed || !tag) throw new Error("the wrapped data key is malformed");
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(sealed), decipher.final()]);
    },
  };
}
