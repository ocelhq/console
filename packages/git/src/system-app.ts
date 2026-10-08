import { envKeyStore } from "./keystore";
import { type GitSettings, readGitSettings } from "./settings";
import { gitStore } from "./store";

export async function syncSystemApp(settings: GitSettings = readGitSettings()): Promise<void> {
  if (!settings.githubApp) return;
  if (!settings.encryptionKey) {
    throw new Error("GITHUB_APP_ID is set but CONSOLE_ENCRYPTION_KEY is not: set it to start.");
  }
  await gitStore(envKeyStore(settings.encryptionKey)).upsertSystemApp("github", settings.githubApp);
}
