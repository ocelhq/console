import { githubProvider } from "./github/provider";
import type { KeyStore } from "./keystore";
import type { GitProvider } from "./provider";
import { type GitStore, gitStore, type StoredApp } from "./store";

export interface GitRuntime {
  store: GitStore;
  providerFor: (app: StoredApp) => GitProvider;
  fetch: typeof fetch;
}

export function gitRuntime(keys: KeyStore, options: { fetch?: typeof fetch } = {}): GitRuntime {
  const fetchImpl = options.fetch ?? fetch;
  return {
    store: gitStore(keys),
    providerFor: (app) => githubProvider(app, { fetch: fetchImpl }),
    fetch: fetchImpl,
  };
}
