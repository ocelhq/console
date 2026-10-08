import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp, organization } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyStore } from "./keystore";
import { gitStore, removeSystemApp } from "./store";
import { syncSystemApp } from "./system-app";

const keys = envKeyStore(randomBytes(32).toString("base64"));
const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;

const githubApp = {
  appId: `4242-${suffix}`,
  slug: "ocel-console",
  privateKey: "PEM",
  webhookSecret: "whsec",
  clientId: "Iv1.x",
  clientSecret: "secret",
};

beforeAll(async () => {
  await setupTestDatabase();
  await removeSystemApp("github");
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
});

afterAll(async () => {
  await removeSystemApp("github");
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("syncSystemApp", () => {
  it("stores nothing when the environment names no app", async () => {
    await syncSystemApp(keys, undefined);
    expect(await db.select().from(gitApp).where(eq(gitApp.id, "system-github"))).toEqual([]);
  });

  it("stores the app the environment names as the system app, sealed", async () => {
    await syncSystemApp(keys, githubApp);

    const [row] = await db.select().from(gitApp).where(eq(gitApp.id, "system-github"));
    expect(row).toMatchObject({ organizationId: null, kind: "github", appId: githubApp.appId });
    expect(row?.privateKeyEnc).not.toContain("PEM");
    const loaded = await gitStore(keys).loadApp("system-github");
    expect(await loaded?.secret("privateKey")).toBe("PEM");
  });

  it("follows the environment on the next start without adding a second app", async () => {
    await syncSystemApp(keys, { ...githubApp, slug: "renamed" });
    await syncSystemApp(keys, { ...githubApp, slug: "renamed" });

    const systemApps = await db.select().from(gitApp).where(isNull(gitApp.organizationId));
    expect(systemApps.filter((row) => row.kind === "github")).toHaveLength(1);
    expect(systemApps[0]?.slug).toBe("renamed");
  });

  it("removes the system app once the environment stops naming one", async () => {
    await syncSystemApp(keys, githubApp);
    await syncSystemApp(keys, undefined);
    expect(await db.select().from(gitApp).where(eq(gitApp.id, "system-github"))).toEqual([]);
  });

  it("refuses, saying why, an app an organization registered as its own", async () => {
    await gitStore(keys).createOrganizationApp({
      id: `app-${suffix}`,
      organizationId: orgId,
      kind: "github",
      ...githubApp,
    });
    await expect(syncSystemApp(keys, githubApp)).rejects.toThrow(
      `GITHUB_APP_ID ${githubApp.appId} is already registered by an organization`,
    );
  });

  it("refuses to start with an app but no key to seal it under", async () => {
    await expect(syncSystemApp(undefined, githubApp)).rejects.toThrow(/CONSOLE_ENCRYPTION_KEY/);
  });
});
