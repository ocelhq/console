import type { KeyStore } from "./keystore";
import { type AppCredentials, gitStore, removeSystemApp } from "./store";

export async function syncSystemApp(
  keys: KeyStore | undefined,
  githubApp: AppCredentials | undefined,
): Promise<void> {
  if (!githubApp) {
    await removeSystemApp("github");
    return;
  }
  if (!keys) {
    throw new Error("GITHUB_APP_ID is set but CONSOLE_ENCRYPTION_KEY is not: set it to start.");
  }
  const stored = await gitStore(keys).replaceSystemApp("github", githubApp);
  if (stored === "claimed") {
    throw new Error(
      `GITHUB_APP_ID ${githubApp.appId} is already registered by an organization on this console as its own app: name another GitHub App in GITHUB_APP_*, or unset them.`,
    );
  }
}
