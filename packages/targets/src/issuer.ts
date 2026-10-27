import type { JWK, JWTPayload } from "jose";
import { type PublishedKey, published, type Signer } from "./signer";

export interface IssuerKeys {
  signer: Signer;
  previous: JWK[];
}

export interface Issuer {
  url: string;
  jwks(): Promise<{ keys: PublishedKey[] }>;
  discovery(): Record<string, unknown>;
  mint(claims: JWTPayload): Promise<string>;
}

export const ISSUER_PATH = "/oidc";

export const TOKEN_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "org",
  "target",
  "tier",
  "project",
] as const;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(typeof bytes === "string" ? encoder.encode(bytes) : bytes).toString(
    "base64url",
  );
}

export function issuerUrl(origin: string): string {
  return `${new URL(origin).origin}${ISSUER_PATH}`;
}

export function createIssuer(origin: string, keys: IssuerKeys): Issuer {
  const url = issuerUrl(origin);
  let current: Promise<PublishedKey> | undefined;
  const signing = () => {
    current ??= published(keys.signer.publicKey);
    return current;
  };

  return {
    url,
    async jwks() {
      const all = [await signing(), ...(await Promise.all(keys.previous.map(published)))];
      return { keys: all.filter((key, at) => all.findIndex((k) => k.kid === key.kid) === at) };
    },
    discovery() {
      return {
        issuer: url,
        jwks_uri: `${url}/jwks`,
        id_token_signing_alg_values_supported: ["ES256"],
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        claims_supported: [...TOKEN_CLAIMS],
      };
    },
    async mint(claims) {
      const header = base64url(
        JSON.stringify({ alg: "ES256", typ: "JWT", kid: (await signing()).kid }),
      );
      const payload = base64url(JSON.stringify({ ...claims, iss: url }));
      const input = `${header}.${payload}`;
      return `${input}.${base64url(await keys.signer.sign(encoder.encode(input)))}`;
    },
  };
}
