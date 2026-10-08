import { env } from "@console/infra/env";
import { privateKey } from "./github/private-key";
import type { AppCredentials } from "./store";

export interface GitSettings {
  encryptionKey: string | undefined;
  githubApp: AppCredentials | undefined;
}

export function readGitSettings(): GitSettings {
  const app = env.githubApp;
  return {
    encryptionKey: env.encryption?.CONSOLE_ENCRYPTION_KEY,
    githubApp: app && {
      appId: app.GITHUB_APP_ID,
      slug: app.GITHUB_APP_SLUG,
      privateKey: privateKey(app.GITHUB_APP_PRIVATE_KEY),
      webhookSecret: app.GITHUB_APP_WEBHOOK_SECRET,
      clientId: app.GITHUB_APP_CLIENT_ID,
      clientSecret: app.GITHUB_APP_CLIENT_SECRET,
    },
  };
}

export function stateSecret(): string {
  return env.BETTER_AUTH_SECRET;
}
