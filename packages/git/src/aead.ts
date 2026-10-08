import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function seal(key: Buffer, plaintext: Buffer, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function open(key: Buffer, sealed: Buffer, context: string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("the sealed value is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}
