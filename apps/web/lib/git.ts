import {
  envKeyStore,
  type GitRuntime,
  gitRuntime,
  type KeyStore,
  readGitSettings,
} from "@console/git";

let keys: KeyStore | null | undefined;
let runtime: GitRuntime | undefined;

export function gitKeyStore(): KeyStore | undefined {
  if (keys === undefined) {
    const { encryptionKey } = readGitSettings();
    keys = encryptionKey ? envKeyStore(encryptionKey) : null;
  }
  return keys ?? undefined;
}

export function git(): GitRuntime | undefined {
  const store = gitKeyStore();
  if (!store) return undefined;
  runtime ??= gitRuntime(store);
  return runtime;
}
