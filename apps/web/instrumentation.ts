export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertSignInMethod, readAuthSettings } = await import("@console/auth/settings");
  assertSignInMethod(readAuthSettings());

  const { pg } = await import("@console/infra");
  const { migrateDatabase } = await import("@console/db/migrate");
  await migrateDatabase(pg);

  const { readGitSettings, syncSystemApp } = await import("@console/git");
  const { gitKeyStore } = await import("./lib/git");
  await syncSystemApp(gitKeyStore(), readGitSettings().githubApp);
}
