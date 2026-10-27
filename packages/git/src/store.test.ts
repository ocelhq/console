import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { gitApp, organization, project, projectRepo } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envKeyStore, type KeyStore } from "./keystore";
import {
  addPipeline,
  grantCredentials,
  narrowPipeline,
  pipelinesOf,
  removePipeline,
  syncLinkedPipeline,
} from "./pipelines";
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
      repo: { id: "1234", fullName: "acme/web", defaultBranch: "main", ownerId: "42" },
      productionBranch: "trunk",
      jobLabels: ["target:vps-box-1"],
    });

    expect(await store.projectsForRepo(first.id, "1234")).toEqual([
      {
        id: `p-${suffix}`,
        organizationId: orgA,
        productionBranch: "trunk",
        jobLabels: ["target:vps-box-1"],
        deploys: "runners",
      },
    ]);
    expect(await store.projectsForRepo(first.id, "other")).toEqual([]);
  });

  it("builds a project's production from its repo's default branch unless the link names one", async () => {
    const installation = await store.findInstallation(appId, "99");
    if (!installation) throw new Error("not bound");
    await store.linkProjectRepo({
      projectId: `p-${suffix}`,
      organizationId: orgA,
      installationId: installation.id,
      repo: { id: "1234", fullName: "acme/web", defaultBranch: "develop", ownerId: "42" },
    });

    expect(await store.projectsForRepo(installation.id, "1234")).toMatchObject([
      { id: `p-${suffix}`, productionBranch: "develop", jobLabels: [] },
    ]);
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
        repo: { id: "5", fullName: "acme/api", defaultBranch: "main", ownerId: "42" },
        productionBranch: "main",
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
      repo: { id: "1234", fullName: "acme/web", defaultBranch: "main", ownerId: "42" },
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

describe("where a linked project's deploys run", () => {
  const ciRepo = { id: "77", fullName: "acme/ci", defaultBranch: "main", ownerId: "42" };

  async function linked(name: string, externalId: string) {
    const app = await organizationApp(`app-${suffix}-${name}`);
    const installation = await store.bindInstallation({
      gitAppId: app.id,
      organizationId: orgA,
      externalId,
      account: "acme",
    });
    if (installation === "claimed") throw new Error("claimed");
    const projectId = `${name}-${suffix}`;
    await db.insert(project).values({ id: projectId, organizationId: orgA, name, slug: projectId });
    await store.linkProjectRepo({
      projectId,
      organizationId: orgA,
      installationId: installation.id,
      repo: ciRepo,
    });
    return { app, installation, projectId };
  }

  async function fromCi(projectId: string) {
    await db.update(projectRepo).set({ deploys: "ci" }).where(eq(projectRepo.projectId, projectId));
    await syncLinkedPipeline(db, projectId);
  }

  async function manual(projectId: string) {
    return addPipeline({
      projectId,
      repository: "acme/ci",
      repositoryId: "77",
      repositoryOwnerId: "42",
      workflow: null,
      environment: null,
      branches: ["*"],
      origin: "manual",
      createdBy: null,
    });
  }

  const origins = async (projectId: string) =>
    (await pipelinesOf(projectId)).map((kept) => kept.origin).sort();

  it("is the console's runners until changed, and every project of the repo says so", async () => {
    const { installation, projectId } = await linked("runs", "400");

    expect(await store.projectsForRepo(installation.id, "77")).toMatchObject([
      { id: projectId, deploys: "runners" },
    ]);
    expect(await store.linkedRepo(projectId)).toMatchObject({
      repoId: "77",
      fullName: "acme/ci",
      account: "acme",
      deploys: "runners",
    });
    expect(await pipelinesOf(projectId)).toEqual([]);
  });

  it("trusts the linked repository's pipeline by its ids while the project deploys from its CI", async () => {
    const { projectId } = await linked("trusted", "405");

    await fromCi(projectId);

    expect(await pipelinesOf(projectId)).toMatchObject([
      {
        origin: "linked",
        repository: "acme/ci",
        repositoryId: "77",
        repositoryOwnerId: "42",
        branches: ["*"],
      },
    ]);
  });

  it("keeps how an admin narrowed the linked pipeline when the link is saved again", async () => {
    const { installation, projectId } = await linked("narrowed", "406");
    await fromCi(projectId);
    const [pipeline] = await pipelinesOf(projectId);
    if (!pipeline) throw new Error("none");
    await narrowPipeline(projectId, pipeline.id, {
      workflow: ".github/workflows/deploy.yml",
      environment: "production",
      branches: ["main"],
    });

    await store.linkProjectRepo({
      projectId,
      organizationId: orgA,
      installationId: installation.id,
      repo: { ...ciRepo, fullName: "acme/renamed" },
    });

    expect(await pipelinesOf(projectId)).toMatchObject([
      {
        id: pipeline.id,
        repository: "acme/renamed",
        workflow: ".github/workflows/deploy.yml",
        environment: "production",
        branches: ["main"],
      },
    ]);
  });

  it("will not remove the linked pipeline while the project deploys from its CI", async () => {
    const { projectId } = await linked("kept", "407");
    await fromCi(projectId);
    const [pipeline] = await pipelinesOf(projectId);
    if (!pipeline) throw new Error("none");

    expect(await removePipeline(projectId, pipeline.id)).toBe("linked");
    expect(await pipelinesOf(projectId)).toHaveLength(1);
  });

  it("forgets the linked pipeline but keeps the manual ones when the project is unlinked", async () => {
    const { projectId } = await linked("unlinked", "401");
    await fromCi(projectId);
    const added = await manual(projectId);

    await store.unlinkProjectRepo(projectId);

    expect(await store.linkedRepo(projectId)).toBeUndefined();
    expect((await pipelinesOf(projectId)).map((kept) => kept.id)).toEqual([added.id]);
  });

  it("goes back to the runners, without the linked pipeline, when the link moves to another repo", async () => {
    const { installation, projectId } = await linked("moved", "402");
    await fromCi(projectId);

    await store.linkProjectRepo({
      projectId,
      organizationId: orgA,
      installationId: installation.id,
      repo: { id: "78", fullName: "acme/other", defaultBranch: "main", ownerId: "42" },
    });

    expect(await store.linkedRepo(projectId)).toMatchObject({ repoId: "78", deploys: "runners" });
    expect(await pipelinesOf(projectId)).toEqual([]);
  });

  it("keeps where deploys run when the link only changes its production branch", async () => {
    const { projectId } = await linked("branch", "403");
    await fromCi(projectId);

    await store.setProductionBranch(projectId, "release");

    expect(await store.linkedRepo(projectId)).toMatchObject({
      productionBranch: "release",
      deploys: "ci",
    });
    expect(await origins(projectId)).toEqual(["linked"]);
  });

  it("lets the linked pipeline take production credentials from the production branch and preview ones from any", async () => {
    const { projectId } = await linked("granted", "408");

    await fromCi(projectId);

    expect((await pipelinesOf(projectId))[0]?.credentials).toEqual({
      production: { branches: ["main"] },
      preview: { branches: ["*"] },
    });
  });

  it("moves the linked pipeline's production credentials to a new production branch, keeping the rest", async () => {
    const { projectId } = await linked("followed", "409");
    await fromCi(projectId);
    const [pipeline] = await pipelinesOf(projectId);
    if (!pipeline) throw new Error("none");
    await grantCredentials(projectId, pipeline.id, {
      production: { branches: ["main"], environment: "production" },
      preview: { branches: ["feat/*"] },
    });

    await store.setProductionBranch(projectId, "release");

    expect((await pipelinesOf(projectId))[0]?.credentials).toEqual({
      production: { branches: ["release"], environment: "production" },
      preview: { branches: ["feat/*"] },
    });
  });

  it("gives the linked pipeline no production credentials back once an admin took them", async () => {
    const { projectId } = await linked("withheld", "410");
    await fromCi(projectId);
    const [pipeline] = await pipelinesOf(projectId);
    if (!pipeline) throw new Error("none");
    await grantCredentials(projectId, pipeline.id, { preview: { branches: ["*"] } });

    await store.setProductionBranch(projectId, "release");

    expect((await pipelinesOf(projectId))[0]?.credentials).toEqual({
      preview: { branches: ["*"] },
    });
  });

  it("gives a pipeline an admin adds no credentials until one grants them", async () => {
    const { projectId } = await linked("manual", "411");

    const added = await manual(projectId);

    expect(added.credentials).toEqual({});
    expect(await grantCredentials(projectId, added.id, { preview: { branches: ["*"] } })).toBe(
      true,
    );
    expect(await grantCredentials(`other-${suffix}`, added.id, {})).toBe(false);
  });

  it("forgets the linked pipelines of the projects linked through an installation that goes", async () => {
    const { app, projectId } = await linked("uninstalled", "404");
    await fromCi(projectId);
    await manual(projectId);

    await store.removeInstallation(app.id, "404");

    expect(await origins(projectId)).toEqual(["manual"]);
  });
});
