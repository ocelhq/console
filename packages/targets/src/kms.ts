import { createHash, createPublicKey } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import type { JWK } from "jose";
import { joseSignature, type Signer } from "./signer";

export interface KmsKeys {
  publicKey(keyId: string): Promise<Uint8Array>;
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

function regionOf(keyId: string): string | undefined {
  return /^arn:aws[a-z-]*:kms:([a-z0-9-]+):/.exec(keyId)?.[1];
}

export function awsKms(): KmsKeys {
  const clients = new Map<string, KMSClient>();
  const clientFor = (keyId: string) => {
    const region = regionOf(keyId) ?? "";
    let client = clients.get(region);
    if (!client) {
      client = new KMSClient(region ? { region } : {});
      clients.set(region, client);
    }
    return client;
  };
  return {
    async publicKey(keyId) {
      const answer = await clientFor(keyId).send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (answer.KeySpec !== "ECC_NIST_P256" || !answer.PublicKey) {
        throw new Error(
          `KMS key ${keyId} is ${answer.KeySpec ?? "no asymmetric key"}: the issuer signs with an ECC_NIST_P256 SIGN_VERIFY key`,
        );
      }
      return answer.PublicKey;
    },
    async sign(keyId, message) {
      const answer = await clientFor(keyId).send(
        new SignCommand({
          KeyId: keyId,
          Message: createHash("sha256").update(message).digest(),
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        }),
      );
      if (!answer.Signature) throw new Error(`KMS key ${keyId} returned no signature`);
      return answer.Signature;
    },
  };
}

export async function kmsPublicKey(keyId: string, kms: KmsKeys): Promise<JWK> {
  const spki = await kms.publicKey(keyId);
  const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error(`KMS key ${keyId} is not a P-256 key, which ES256 signs with`);
  }
  return key.export({ format: "jwk" }) as JWK;
}

export async function kmsSigner(keyId: string, kms: KmsKeys): Promise<Signer> {
  return {
    publicKey: await kmsPublicKey(keyId, kms),
    async sign(message) {
      return joseSignature(await kms.sign(keyId, message));
    },
  };
}
