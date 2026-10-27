import { env } from "@console/infra/env";

export type IssuerKeySource = { kind: "kms"; keyId: string } | { kind: "key"; key: string };

export interface IssuerSettings {
  current: IssuerKeySource;
  previous: IssuerKeySource[];
}

export const ISSUER_UNCONFIGURED =
  "This console issues no cloud credentials: set CONSOLE_ISSUER_KMS_KEY_ID (an AWS KMS ECC_NIST_P256 signing key) or CONSOLE_ISSUER_KEY (a P-256 private key, PEM or JWK) and restart it";

export function readIssuerSettings(): IssuerSettings | undefined {
  const kmsKeyId = env.CONSOLE_ISSUER_KMS_KEY_ID;
  const key = env.issuerKey?.CONSOLE_ISSUER_KEY;
  const current: IssuerKeySource | undefined = kmsKeyId
    ? { kind: "kms", keyId: kmsKeyId }
    : key
      ? { kind: "key", key }
      : undefined;
  if (!current) return undefined;
  const previous: IssuerKeySource[] = [];
  if (env.CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID) {
    previous.push({ kind: "kms", keyId: env.CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID });
  }
  const retired = env.issuerPreviousKey?.CONSOLE_ISSUER_PREVIOUS_KEY;
  if (retired) previous.push({ kind: "key", key: retired });
  return { current, previous };
}
