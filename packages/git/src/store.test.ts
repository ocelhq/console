import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyStore } from "./keystore";
import { gitStore } from "./store";

const suffix = crypto.randomUUID();
const orgA = `org-a-${suffix}`;
const orgB = `org-b-${suffix}`;
const keys = envKeyStore(randomBytes(32).toString("base64"));
const store = gitStore(keys);

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

beforeAll(async () => {
  await setupTestDatabase();
  await db.insert(organization).values([
    { id: orgA, name: "A", slug: orgA, createdAt: new Date() },
    { id: orgB, name: "B", slug: orgB, createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
  await db.delete(gitApp).where(eq(gitApp.id, "system-github"));
  await pg.end();
});

describe("organization apps", () => {
  it("keeps secrets encrypted at rest and hands them back opened", async () => {
    const created = await store.createOrganizationApp({
      id: `app-${suffix}-1`,
      organizationId: orgA,
      kind: "github",
      ...credentials(`1${suffix}`),
    });

    const [row] = await db.select().from(gitApp).where(eq(gitApp.id, created.id));
    expect(row?.privateKeyEnc).not.toContain("PRIVATE KEY");
    expect(row?.webhookSecretEnc).not.toContain("whsec");
    expect(row?.clientSecretEnc).not.toContain("client-secret");

    const loaded = await store.loadApp(created.id);
    expect(loaded).toMatchObject({
      id: created.id,
      organizationId: orgA,
      kind: "github",
      privateKey: "PRIVATE KEY",
      webhookSecret: "whsec",
      clientSecret: "client-secret",
    });
  });

  it("answers nothing for an app it does not know", async () => {
    expect(await store.loadApp("nope")).toBeUndefined();
  });
});

describe("system app", () => {
  it("is upserted in place, owned by no organization, and usable by every one", async () => {
    await store.upsertSystemApp("github", credentials(`s1${suffix}`));
    await store.upsertSystemApp("github", { ...credentials(`s2${suffix}`), slug: "renamed" });

    const rows = await db.select().from(gitApp).where(eq(gitApp.id, "system-github"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, appId: `s2${suffix}`, slug: "renamed" });

    const forA = await store.appsFor(orgA);
    const forB = await store.appsFor(orgB);
    expect(forA.map((app) => app.id)).toContain("system-github");
    expect(forA.map((app) => app.id)).toContain(`app-${suffix}-1`);
    expect(forB.map((app) => app.id)).toContain("system-github");
    expect(forB.map((app) => app.id)).not.toContain(`app-${suffix}-1`);
  });
});

describe("installations and repos", () => {
  it("records an installation once and links a project to a repo of it", async () => {
    const appId = `app-${suffix}-1`;
    const first = await store.recordInstallation({
      gitAppId: appId,
      organizationId: orgA,
      externalId: "99",
      account: "acme",
    });
    const again = await store.recordInstallation({
      gitAppId: appId,
      organizationId: orgA,
      externalId: "99",
      account: "acme-renamed",
    });
    expect(again.id).toBe(first.id);
    expect(again.account).toBe("acme-renamed");

    await db.insert(project).values({
      id: `p-${suffix}`,
      organizationId: orgA,
      name: "P",
      slug: "p",
    });
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

  it("refuses to link a project to another organization's installation", async () => {
    const installation = await store.recordInstallation({
      gitAppId: `app-${suffix}-1`,
      organizationId: orgA,
      externalId: "100",
      account: "acme",
    });
    await db.insert(project).values({
      id: `q-${suffix}`,
      organizationId: orgB,
      name: "Q",
      slug: "q",
    });

    await expect(
      store.linkProjectRepo({
        projectId: `q-${suffix}`,
        organizationId: orgB,
        installationId: installation.id,
        repo: { id: "5", fullName: "acme/api" },
      }),
    ).rejects.toThrow(/installation/);
  });

  it("forgets an installation and unlinks its projects", async () => {
    const found = await store.findInstallation(`app-${suffix}-1`, "99");
    await store.removeInstallation(`app-${suffix}-1`, "99");

    expect(await store.findInstallation(`app-${suffix}-1`, "99")).toBeUndefined();
    const [linked] = await db
      .select()
      .from(project)
      .where(eq(project.id, `p-${suffix}`));
    expect(found).toBeDefined();
    expect(linked?.repoInstallationId).toBeNull();
  });
});
