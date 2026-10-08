import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyStore } from "./keystore";
import type { GitSettings } from "./settings";
import { gitStore } from "./store";
import { syncSystemApp } from "./system-app";

const key = randomBytes(32).toString("base64");

const githubApp = {
  appId: "4242",
  slug: "ocel-console",
  privateKey: "PEM",
  webhookSecret: "whsec",
  clientId: "Iv1.x",
  clientSecret: "secret",
};

const settings = (over: Partial<GitSettings>): GitSettings => ({
  encryptionKey: key,
  githubApp,
  ...over,
});

beforeAll(async () => {
  await setupTestDatabase();
  await db.delete(gitApp).where(eq(gitApp.id, "system-github"));
});

afterAll(async () => {
  await db.delete(gitApp).where(eq(gitApp.id, "system-github"));
  await pg.end();
});

describe("syncSystemApp", () => {
  it("stores nothing when the environment names no app", async () => {
    await syncSystemApp(settings({ githubApp: undefined }));
    expect(await db.select().from(gitApp).where(eq(gitApp.id, "system-github"))).toEqual([]);
  });

  it("stores the app the environment names as the system app, sealed", async () => {
    await syncSystemApp(settings({}));

    const [row] = await db.select().from(gitApp).where(eq(gitApp.id, "system-github"));
    expect(row).toMatchObject({ organizationId: null, kind: "github", appId: "4242" });
    expect(row?.privateKeyEnc).not.toContain("PEM");
    expect(await gitStore(envKeyStore(key)).loadApp("system-github")).toMatchObject({
      privateKey: "PEM",
      webhookSecret: "whsec",
      clientSecret: "secret",
    });
  });

  it("follows the environment on the next start without adding a second app", async () => {
    await syncSystemApp(settings({ githubApp: { ...githubApp, slug: "renamed" } }));
    await syncSystemApp(settings({ githubApp: { ...githubApp, slug: "renamed" } }));

    const systemApps = await db.select().from(gitApp).where(isNull(gitApp.organizationId));
    expect(systemApps.filter((row) => row.kind === "github")).toHaveLength(1);
    expect(systemApps[0]?.slug).toBe("renamed");
  });

  it("refuses to start with an app but no key to seal it under", async () => {
    await expect(syncSystemApp(settings({ encryptionKey: undefined }))).rejects.toThrow(
      /CONSOLE_ENCRYPTION_KEY/,
    );
  });
});
