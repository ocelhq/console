export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertSignInMethod, readAuthSettings } = await import("@console/auth/settings");
  assertSignInMethod(readAuthSettings());

  const { pg } = await import("@console/infra");
  const { migrateDatabase } = await import("@console/db/migrate");
  await migrateDatabase(pg);
}
