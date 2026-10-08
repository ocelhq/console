import { envKeyStore, type KeyStore } from "./keystore";
import { type GitRuntime, gitRuntime } from "./runtime";
import { readGitSettings } from "./settings";

let keys: KeyStore | null | undefined;
let runtime: GitRuntime | undefined;

export function gitKeyStore(): KeyStore | undefined {
  if (keys === undefined) {
    const { encryptionKey } = readGitSettings();
    keys = encryptionKey ? envKeyStore(encryptionKey) : null;
  }
  return keys ?? undefined;
}

export function configuredGit(): GitRuntime | undefined {
  const store = gitKeyStore();
  if (!store) return undefined;
  runtime ??= gitRuntime(store);
  return runtime;
}
