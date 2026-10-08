import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp, gitDelivery, organization, project, projectRepo } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyStore, type KeyStore } from "./keystore";
import { gitStore, removeSystemApp, systemAppId } from "./store";

const suffix = crypto.randomUUID();
const orgA = `org-a-${suffix}`;
const orgB = `org-b-${suffix}`;
const unwrapped: string[] = [];
const envKeys = envKeyStore(randomBytes(32).toString("base64"));
const keys: KeyStore = {
  wrap: envKeys.wrap,
  async unwrap(key, context) {
    unwrapped.push(context);
    return envKeys.unwrap(key, context);
  },
};
const store = gitStore(keys);
const SYSTEM = systemAppId("github");

function credentials(appId: string) {
  return {
    appId,
    slug: `app-${appId}`,
    privateKey: "PRIVATE KEY",
    webhookSecret: "whsec",
    clientId: "Iv1.abc",
    clientSecret: "client-secret",
  };
}

async function organizationApp(id: string, organizationId = orgA) {
  const created = await store.createOrganizationApp({
    id,
    organizationId,
    kind: "github",
    ...credentials(`gh-${id}`),
  });
  if (!created) throw new Error("not created");
  return created;
}

beforeAll(async () => {
  await setupTestDatabase();
  await removeSystemApp("github");
  await db.insert(organization).values([
    { id: orgA, name: "A", slug: orgA, createdAt: new Date() },
    { id: orgB, name: "B", slug: orgB, createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
  await removeSystemApp("github");
  await pg.end();
});

describe("organization apps", () => {
  it("keeps secrets encrypted at rest and opens each only when asked", async () => {
    const created = await organizationApp(`app-${suffix}-1`);

    const [row] = await db.select().from(gitApp).where(eq(gitApp.id, created.id));
    expect(row?.privateKeyEnc).not.toContain("PRIVATE KEY");
    expect(row?.webhookSecretEnc).not.toContain("whsec");
    expect(row?.clientSecretEnc).not.toContain("client-secret");

    unwrapped.length = 0;
    const loaded = await store.loadApp(created.id);
    expect(loaded).toMatchObject({ id: created.id, organizationId: orgA, kind: "github" });
    expect(unwrapped).toEqual([]);

    expect(await loaded?.secret("webhookSecret")).toBe("whsec");
    expect(await loaded?.secret("webhookSecret")).toBe("whsec");
    expect(unwrapped).toEqual([`git_app/${created.id}/webhook_secret`]);
    expect(await loaded?.secret("privateKey")).toBe("PRIVATE KEY");
    expect(await loaded?.secret("clientSecret")).toBe("client-secret");
  });

  it("will not open a secret copied onto another app's row", async () => {
    const victim = await organizationApp(`app-${suffix}-victim`);
    const thief = await organizationApp(`app-${suffix}-thief`, orgB);
    const [sealed] = await db
      .select({ privateKeyEnc: gitApp.privateKeyEnc })
      .from(gitApp)
      .where(eq(gitApp.id, victim.id));
    await db
      .update(gitApp)
      .set({ webhookSecretEnc: sealed?.privateKeyEnc })
      .where(eq(gitApp.id, thief.id));

    const loaded = await store.loadApp(thief.id);
    await expect(loaded?.secret("webhookSecret")).rejects.toThrow();
  });

  it("stores nothing over an app it already holds", async () => {
    const first = await organizationApp(`app-${suffix}-twice`);
    expect(
      await store.createOrganizationApp({
        id: first.id,
        organizationId: orgB,
        kind: "github",
        ...credentials("another"),
      }),
    ).toBeUndefined();
    expect(
      await store.createOrganizationApp({
        id: `app-${suffix}-same-github-app`,
        organizationId: orgB,
        kind: "github",
        ...credentials(first.appId),
      }),
    ).toBeUndefined();
    expect((await store.loadApp(first.id))?.organizationId).toBe(orgA);
  });

  it("answers nothing for an app it does not know", async () => {
    expect(await store.loadApp("nope")).toBeUndefined();
  });
});

describe("system app", () => {
  it("is upserted in place, owned by no organization, and usable by every one", async () => {
    await store.replaceSystemApp("github", credentials(`s1${suffix}`));
    await store.replaceSystemApp("github", { ...credentials(`s1${suffix}`), slug: "renamed" });

    const rows = await db.select().from(gitApp).where(eq(gitApp.id, SYSTEM));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, appId: `s1${suffix}`, slug: "renamed" });

    const forA = (await store.appsFor(orgA)).map((app) => app.id);
    const forB = (await store.appsFor(orgB)).map((app) => app.id);
    expect(forA).toEqual(expect.arrayContaining([SYSTEM, `app-${suffix}-1`]));
    expect(forB).toContain(SYSTEM);
    expect(forB).not.toContain(`app-${suffix}-1`);
  });

  it("keeps its installations while it stays the same GitHub App", async () => {
    await store.replaceSystemApp("github", credentials(`s1${suffix}`));
    await store.bindInstallation({
      gitAppId: SYSTEM,
      organizationId: orgA,
      externalId: "700",
      account: "acme",
    });
    await store.replaceSystemApp("github", { ...credentials(`s1${suffix}`), slug: "again" });
    expect(await store.findInstallation(SYSTEM, "700")).toBeDefined();
  });

  it("drops the old app's installations when the environment names another GitHub App", async () => {
    await store.replaceSystemApp("github", credentials(`s2${suffix}`));
    expect(await store.findInstallation(SYSTEM, "700")).toBeUndefined();
    const [row] = await db.select().from(gitApp).where(eq(gitApp.id, SYSTEM));
    expect(row?.appId).toBe(`s2${suffix}`);
  });

  it("refuses a GitHub App an organization already registered as its own", async () => {
    const owned = await organizationApp(`app-${suffix}-owned`);
    expect(await store.replaceSystemApp("github", credentials(owned.appId))).toBe("claimed");
    const [row] = await db.select().from(gitApp).where(eq(gitApp.id, SYSTEM));
    expect(row?.appId).toBe(`s2${suffix}`);
  });

  it("is removed with everything installed from it", async () => {
    await store.bindInstallation({
      gitAppId: SYSTEM,
      organizationId: orgA,
      externalId: "701",
      account: "acme",
    });
    await removeSystemApp("github");
    expect(await db.select().from(gitApp).where(eq(gitApp.id, SYSTEM))).toEqual([]);
    expect(await store.findInstallation(SYSTEM, "701")).toBeUndefined();
  });
});

describe("installations and repos", () => {
  const appId = `app-${suffix}-1`;

  it("binds an installation once and links a project to a repo of it", async () => {
    const first = await store.bindInstallation({
      gitAppId: appId,
      organizationId: orgA,
      externalId: "99",
      account: "acme",
    });
    const again = await store.bindInstallation({
      gitAppId: appId,
      organizationId: orgA,
      externalId: "99",
      account: "acme-renamed",
    });
    if (first === "claimed" || again === "claimed") throw new Error("claimed");
    expect(again.id).toBe(first.id);
    expect(again.account).toBe("acme-renamed");

    await db
      .insert(project)
      .values({ id: `p-${suffix}`, organizationId: orgA, name: "P", slug: "p" });
    await store.linkProjectRepo({
      projectId: `p-${suffix}`,
      organizationId: orgA,
      installationId: first.id,
      repo: { id: "1234", fullName: "acme/web" },
    });

    expect(await store.projectsForRepo(first.id, "1234")).toEqual([
      { id: `p-${suffix}`, organizationId: orgA },
    ]);
    expect(await store.projectsForRepo(first.id, "other")).toEqual([]);
  });

  it("refuses to bind an installation another organization holds", async () => {
    expect(
      await store.bindInstallation({
        gitAppId: appId,
        organizationId: orgB,
        externalId: "99",
        account: "stolen",
      }),
    ).toBe("claimed");
    expect(await store.findInstallation(appId, "99")).toMatchObject({
      organizationId: orgA,
      account: "acme-renamed",
    });
  });

  it("lists the installations an organization made, with the app each belongs to", async () => {
    const mine = await store.installationsFor(orgA);
    expect(mine.map((row) => [row.externalId, row.gitAppId, row.account])).toContainEqual([
      "99",
      appId,
      "acme-renamed",
    ]);
    expect((await store.installationsFor(orgB)).map((row) => row.externalId)).not.toContain("99");
  });

  it("refuses to link a project to another organization's installation", async () => {
    const installation = await store.bindInstallation({
      gitAppId: appId,
      organizationId: orgA,
      externalId: "100",
      account: "acme",
    });
    if (installation === "claimed") throw new Error("claimed");
    await db
      .insert(project)
      .values({ id: `q-${suffix}`, organizationId: orgB, name: "Q", slug: "q" });

    await expect(
      store.linkProjectRepo({
        projectId: `q-${suffix}`,
        organizationId: orgB,
        installationId: installation.id,
        repo: { id: "5", fullName: "acme/api" },
      }),
    ).rejects.toThrow(/installation/);
  });

  it("forgets an installation and the repo links made through it", async () => {
    await store.removeInstallation(appId, "99");

    expect(await store.findInstallation(appId, "99")).toBeUndefined();
    expect(
      await db
        .select()
        .from(projectRepo)
        .where(eq(projectRepo.projectId, `p-${suffix}`)),
    ).toEqual([]);
  });

  it("leaves no half a repo link behind when the app goes", async () => {
    const app = await organizationApp(`app-${suffix}-doomed`);
    const installation = await store.bindInstallation({
      gitAppId: app.id,
      organizationId: orgA,
      externalId: "300",
      account: "acme",
    });
    if (installation === "claimed") throw new Error("claimed");
    await store.linkProjectRepo({
      projectId: `p-${suffix}`,
      organizationId: orgA,
      installationId: installation.id,
      repo: { id: "1234", fullName: "acme/web" },
    });

    await db.delete(gitApp).where(eq(gitApp.id, app.id));

    expect(
      await db
        .select()
        .from(projectRepo)
        .where(eq(projectRepo.projectId, `p-${suffix}`)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(project)
        .where(eq(project.id, `p-${suffix}`)),
    ).toHaveLength(1);
  });
});

describe("deliveries", () => {
  const appId = `app-${suffix}-1`;

  it("takes a delivery once", async () => {
    expect(await store.recordDelivery(appId, "d-1")).toBe(true);
    expect(await store.recordDelivery(appId, "d-1")).toBe(false);
  });

  it("takes a delivery again once it is forgotten", async () => {
    await store.forgetDelivery(appId, "d-1");
    expect(await store.recordDelivery(appId, "d-1")).toBe(true);
  });

  it("forgets deliveries older than it keeps", async () => {
    await db.insert(gitDelivery).values({
      gitAppId: appId,
      deliveryId: "d-old",
      receivedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    await store.recordDelivery(appId, "d-new");
    expect(
      await db
        .select()
        .from(gitDelivery)
        .where(and(eq(gitDelivery.gitAppId, appId), eq(gitDelivery.deliveryId, "d-old"))),
    ).toEqual([]);
  });
});
