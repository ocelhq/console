import { createIssuer, type Issuer } from "./issuer";
import { keySigner, publicKeyOf } from "./key";
import { awsKms, type KmsKeys, kmsPublicKey, kmsSigner } from "./kms";
import { type IssuerKeySource, readIssuerSettings } from "./settings";

let cached: { key: string; issuer: Promise<Issuer> } | undefined;
let kmsKeys: KmsKeys | undefined;

async function keysFrom(current: IssuerKeySource, previous: IssuerKeySource[], kms: () => KmsKeys) {
  return {
    signer: current.kind === "kms" ? await kmsSigner(current.keyId, kms()) : keySigner(current.key),
    previous: await Promise.all(
      previous.map((source) =>
        source.kind === "kms" ? kmsPublicKey(source.keyId, kms()) : publicKeyOf(source.key),
      ),
    ),
  };
}

export function configuredIssuer(origin: string): Promise<Issuer> | undefined {
  const settings = readIssuerSettings();
  if (!settings) return undefined;
  const key = JSON.stringify([origin, settings]);
  if (cached?.key !== key) {
    const issuer = keysFrom(settings.current, settings.previous, () => {
      kmsKeys ??= awsKms();
      return kmsKeys;
    }).then((keys) => createIssuer(origin, keys));
    const entry = { key, issuer };
    cached = entry;
    issuer.catch(() => {
      if (cached === entry) cached = undefined;
    });
  }
  return cached.issuer;
}
