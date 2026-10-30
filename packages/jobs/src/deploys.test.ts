import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import {
  type Job,
  job,
  organization,
  project,
  projectRepo,
  trustedPipeline,
} from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { addPipeline, envKeyStore, gitStore, pipelinesOf } from "@console/git";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deployIn } from "./deploys";
import type { JobDeps } from "./deps";
import { fakeRunner } from "./fake-runner";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const projectId = `p-${suffix}`;
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));
const repo = { repository: "acme/web", repositoryId: "1234", repositoryOwnerId: "42" };

let notified: Job[] = [];
const notify: JobDeps = {
  runners: fakeRunner(),
  notify: async (changed: Job) => {
    notified.push(changed);
  },
};

async function queued(status: Job["status"], over: Partial<typeof job.$inferInsert> = {}) {
  await db.insert(job).values({
    id: crypto.randomUUID(),
    projectId,
    kind: "preview-up",
    tier: "preview",
    status,
    pr: status === "queued" ? 7 : 8,
    dedupeKey: crypto.randomUUID(),
    eventAt: new Date(),
    runnerId: "ocel-cloud",
    spec: {
      source: { git: { cloneUrl: "https://github.com/acme/web.git", commit: "a".repeat(40) } },
    },
    ...over,
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  await store.createOrganizationApp({
    id: appRowId,
    organizationId: orgId,
    kind: "github",
    appId: `gh-${suffix}`,
    slug: "mine",
    privateKey: "k",
    webhookSecret: "w",
    clientId: "c",
    clientSecret: "cs",
  });
  const bound = await store.bindInstallation({
    gitAppId: appRowId,
    organizationId: orgId,
    externalId: "556",
    account: "acme",
  });
  if (bound === "claimed") throw new Error("claimed");
  await db
    .insert(project)
    .values({ id: projectId, organizationId: orgId, name: "Web", slug: "web" });
  await store.linkProjectRepo({
    projectId,
    organizationId: orgId,
    installationId: bound.id,
    repo: { id: "1234", fullName: "acme/web", defaultBranch: "main", ownerId: "42" },
  });
});

beforeEach(async () => {
  await db.delete(job).where(eq(job.projectId, projectId));
  await db.delete(trustedPipeline).where(eq(trustedPipeline.projectId, projectId));
  notified = [];
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("moving a project's deploys to its own CI", () => {
  it("cancels what waits for a runner, asks a runner to stop what it runs, trusts the linked repo's pipelines, and says so", async () => {
    await queued("queued");
    await queued("running", { dispatchedAt: new Date(), acknowledgedAt: new Date() });
    await queued("queued", { pr: 9, spec: { source: { sourceId: "c".repeat(64) } } });

    await deployIn(projectId, { mode: "ci", by: null }, notify);

    expect(await store.linkedRepo(projectId)).toMatchObject({ deploys: "ci" });
    const rows = await db.select().from(job).where(eq(job.projectId, projectId));
    expect(rows.map((row) => [row.pr, row.status, row.cancelRequested]).sort()).toEqual([
      [7, "canceled", false],
      [8, "canceled", true],
      [9, "queued", false],
    ]);
    expect(notified.map((changed) => [changed.pr, changed.status])).toEqual([
      [7, "canceled"],
      [8, "running"],
      [8, "canceled"],
    ]);
    expect(await pipelinesOf(projectId)).toMatchObject([
      { origin: "linked", kind: "github-actions", ...repo, branches: ["*"] },
    ]);
  });

  it("trusts one linked pipeline however often it is chosen", async () => {
    await deployIn(projectId, { mode: "ci", by: null }, notify);
    await deployIn(projectId, { mode: "ci", by: null }, notify);

    expect(await pipelinesOf(projectId)).toHaveLength(1);
  });
});

describe("moving a project's deploys back to the runners", () => {
  it("forgets the linked pipeline and keeps the ones added by hand", async () => {
    await deployIn(projectId, { mode: "ci", by: null }, notify);
    const manual = await addPipeline({
      projectId,
      ...repo,
      workflow: null,
      environment: null,
      branches: ["main"],
      origin: "manual",
      createdBy: null,
    });

    await deployIn(projectId, { mode: "runners", by: null }, notify);

    expect(await store.linkedRepo(projectId)).toMatchObject({ deploys: "runners" });
    expect((await pipelinesOf(projectId)).map((kept) => kept.id)).toEqual([manual.id]);
  });
});

it("refuses a project linked to no repo", async () => {
  await expect(
    deployIn(`missing-${suffix}`, { mode: "runners", by: null }, notify),
  ).rejects.toThrow(/linked/);
});

it("refuses to trust a linked repository whose owner it never learned, and changes nothing", async () => {
  await db
    .update(projectRepo)
    .set({ repoOwnerId: null })
    .where(eq(projectRepo.projectId, projectId));
  try {
    await expect(deployIn(projectId, { mode: "ci", by: null }, notify)).rejects.toThrow(/again/);
    expect(await store.linkedRepo(projectId)).toMatchObject({ deploys: "runners" });
    expect(await pipelinesOf(projectId)).toEqual([]);
  } finally {
    await db
      .update(projectRepo)
      .set({ repoOwnerId: "42" })
      .where(eq(projectRepo.projectId, projectId));
  }
});
