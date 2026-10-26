export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertSignInMethod, readAuthSettings } = await import("@console/auth/settings");
  assertSignInMethod(readAuthSettings());

  const { readGitSettings, syncSystemApp } = await import("@console/git");
  const { gitKeyStore } = await import("./lib/git");
  await syncSystemApp(gitKeyStore(), readGitSettings().githubApp);
}
