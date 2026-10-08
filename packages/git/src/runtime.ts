import { githubProvider } from "./github/provider";
import { envKeyStore } from "./keystore";
import type { GitProvider } from "./provider";
import { readGitSettings } from "./settings";
import { type GitStore, gitStore, type OpenedApp } from "./store";

export interface GitRuntime {
  store: GitStore;
  providerFor: (app: OpenedApp) => GitProvider;
}

export function providerFor(app: OpenedApp): GitProvider {
  return githubProvider({
    appId: app.appId,
    privateKey: app.privateKey,
    webhookSecret: app.webhookSecret,
  });
}

let runtime: GitRuntime | undefined;

export function gitRuntime(): GitRuntime | undefined {
  const { encryptionKey } = readGitSettings();
  if (!encryptionKey) return undefined;
  runtime ??= { store: gitStore(envKeyStore(encryptionKey)), providerFor };
  return runtime;
}
