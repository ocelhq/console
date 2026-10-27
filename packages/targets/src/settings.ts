import { env } from "@console/infra/env";

export type IssuerKeySource = { kind: "kms"; keyId: string } | { kind: "key"; key: string };

export interface IssuerSettings {
  current: IssuerKeySource;
  previous: IssuerKeySource[];
}

export const ISSUER_UNCONFIGURED =
  "This console issues no cloud credentials: set CONSOLE_ISSUER_KMS_KEY_ID (an AWS KMS ECC_NIST_P256 signing key) or CONSOLE_ISSUER_KEY (a P-256 private key, PEM or JWK) and restart it";

function source(kmsKeyId: string | undefined, key: string | undefined): IssuerKeySource[] {
  if (kmsKeyId) return [{ kind: "kms", keyId: kmsKeyId }];
  if (key) return [{ kind: "key", key }];
  return [];
}

export function readIssuerSettings(): IssuerSettings | undefined {
  const [current] = source(env.CONSOLE_ISSUER_KMS_KEY_ID, env.issuerKey?.CONSOLE_ISSUER_KEY);
  if (!current) return undefined;
  const previous: IssuerKeySource[] = [];
  if (env.CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID) {
    previous.push({ kind: "kms", keyId: env.CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID });
  }
  const retired = env.issuerPreviousKey?.CONSOLE_ISSUER_PREVIOUS_KEY;
  if (retired) previous.push({ kind: "key", key: retired });
  return { current, previous };
}
