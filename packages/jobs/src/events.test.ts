import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { type Job, job, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, type GitEvent, gitStore } from "@console/git";
import { pg } from "@console/infra";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleGitEvent, toWire } from "./events";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const projects = [`p1-${suffix}`, `p2-${suffix}`];
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));
const repo = { id: "1234", fullName: "acme/web", defaultBranch: "main" };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 10, minute));
const sha = (c: string) => c.repeat(40);

let notified: Job[] = [];
const deps = {
  store,
  notify: async (queued: Job) => {
    notified.push(queued);
  },
};

const pullRequest = {
  installation: "556",
  repo,
  pr: 7,
  sha: sha("a"),
  branch: "feature/x",
  draft: false,
  fork: false,
  at: at(0),
};
const opened = (over: Partial<typeof pullRequest> & { reopened?: boolean } = {}): GitEvent => ({
  type: "pr_opened",
  reopened: false,
  ...pullRequest,
  ...over,
});
const synced = (over: Partial<typeof pullRequest> = {}): GitEvent => ({
  type: "pr_sync",
  ...pullRequest,
  ...over,
});
const closed = (minute: number, merged = false): GitEvent => ({
  type: "pr_closed",
  installation: "556",
  repo,
  pr: 7,
  merged,
  at: at(minute),
});

function run(event: GitEvent, deliveryId: string = crypto.randomUUID()) {
  return handleGitEvent({ deliveryId, appId: appRowId, event: toWire(event) }, deps);
}

async function jobs(projectId = projects[0] as string) {
  return db.select().from(job).where(eq(job.projectId, projectId)).orderBy(asc(job.createdAt));
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
    .values(projects.map((id, at) => ({ id, organizationId: orgId, name: id, slug: `s${at}` })));
  await store.linkProjectRepo({
    projectId: projects[0] as string,
    organizationId: orgId,
    installationId: bound.id,
    repo,
    jobLabels: ["target:vps-box-1"],
  });
  await store.linkProjectRepo({
    projectId: projects[1] as string,
    organizationId: orgId,
    installationId: bound.id,
    repo,
    productionBranch: "release",
  });
});

beforeEach(async () => {
  await db.delete(job).where(inArray(job.projectId, projects));
  notified = [];
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("a push", () => {
  const push = (branch: string, deleted = false, minute = 0, commit = "b"): GitEvent => ({
    type: "push",
    installation: "556",
    repo,
    branch,
    sha: sha(commit),
    deleted,
    at: at(minute),
  });

  it("queues a deploy for each project whose production branch it is, routed by the project's labels", async () => {
    await run(push("main"));

    expect(await jobs()).toMatchObject([
      {
        kind: "deploy",
        status: "queued",
        sha: sha("b"),
        branch: "main",
        pr: 0,
        labels: ["target:vps-box-1"],
        eventAt: at(0),
      },
    ]);
    expect(await jobs(projects[1])).toEqual([]);
    expect(notified.map((n) => n.kind)).toEqual(["deploy"]);
  });

  it("queues nothing for a push older than the last one it deployed", async () => {
    await run(push("main", false, 5, "c"));
    await run(push("main", false, 1, "b"));

    expect((await jobs()).map((j) => j.sha)).toEqual([sha("c")]);
  });

  it("queues nothing for another branch or for a deleted one", async () => {
    await run(push("feature/x"));
    await run(push("main", true));

    expect(await jobs()).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe("a pull request", () => {
  it("queues a preview for every project linked to the repo", async () => {
    await run(opened());

    for (const id of projects) {
      expect(await jobs(id)).toMatchObject([
        { kind: "preview-up", status: "queued", pr: 7, sha: sha("a"), branch: "feature/x" },
      ]);
    }
  });

  it("queues no preview for a fork, which no one approved to run code", async () => {
    await run(opened({ fork: true }));
    await run(synced({ fork: true }));

    expect(await jobs()).toEqual([]);
  });

  it("replaces a queued preview of an older commit and asks a running one to stop", async () => {
    await run(opened());
    const [first] = await jobs();
    await run(synced({ sha: sha("c"), at: at(1) }));
    const [second] = (await jobs()).slice(1);
    await db
      .update(job)
      .set({ status: "running" })
      .where(eq(job.id, second?.id ?? ""));

    await run(synced({ sha: sha("d"), at: at(2) }));

    const all = await jobs();
    expect(all.map((j) => [j.sha, j.status, j.cancelRequested])).toEqual([
      [sha("a"), "canceled", false],
      [sha("c"), "running", true],
      [sha("d"), "queued", false],
    ]);
    expect(first?.id).toBe(all[0]?.id);
  });

  it("leaves another pull request's jobs alone", async () => {
    await run(opened({ pr: 8 }));
    await run(opened());

    expect((await jobs()).map((j) => [j.pr, j.status])).toEqual([
      [8, "queued"],
      [7, "queued"],
    ]);
  });

  it("queues a removal when it closes, in place of whatever was waiting", async () => {
    await run(opened());
    await db
      .update(job)
      .set({ status: "done", claimedAt: new Date() })
      .where(inArray(job.projectId, projects));
    await run(synced({ sha: sha("c"), at: at(1) }));

    await run(closed(2));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-up", "done"],
      ["preview-up", "canceled"],
      ["preview-rm", "queued"],
    ]);
  });

  it("reports what it replaced, so a canceled preview stops saying it waits", async () => {
    await run(opened());
    notified = [];

    await run(synced({ sha: sha("c"), at: at(1) }));

    expect(
      notified.filter((n) => n.projectId === projects[0]).map((n) => [n.sha, n.status]),
    ).toEqual([
      [sha("a"), "canceled"],
      [sha("c"), "queued"],
    ]);
  });

  it("closes a preview that never ran without asking a runner to remove it, and says so", async () => {
    await run(opened());
    notified = [];

    await run(closed(1, true));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-up", "canceled"],
      ["preview-rm", "done"],
    ]);
    expect(
      notified.filter((n) => n.projectId === projects[0]).map((n) => [n.kind, n.status]),
    ).toEqual([
      ["preview-up", "canceled"],
      ["preview-rm", "done"],
    ]);
  });

  it("records a close with no preview behind it without reporting it", async () => {
    await run(closed(1));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([["preview-rm", "done"]]);
    expect(notified).toEqual([]);
  });

  it("queues no preview for an update that arrives after the pull request closed", async () => {
    await run(opened());
    await run(closed(5));

    await run(synced({ sha: sha("c"), at: at(3) }));
    await run(synced({ sha: sha("d"), at: at(5) }));
    await run(opened({ at: at(6) }));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-up", "canceled"],
      ["preview-rm", "done"],
    ]);
  });

  it("queues no preview for an update older than the one it already queued", async () => {
    await run(synced({ sha: sha("d"), at: at(2) }));
    await run(synced({ sha: sha("c"), at: at(1) }));

    expect((await jobs()).map((j) => [j.sha, j.status])).toEqual([[sha("d"), "queued"]]);
  });

  it("queues a preview again when a closed pull request reopens", async () => {
    await run(opened());
    await db
      .update(job)
      .set({ status: "done", claimedAt: new Date() })
      .where(inArray(job.projectId, projects));
    await run(closed(1));
    await run(opened({ reopened: true, at: at(2) }));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-up", "done"],
      ["preview-rm", "canceled"],
      ["preview-up", "queued"],
    ]);
  });
});

describe("a delivery that arrives again", () => {
  it("adds nothing and reports nothing, leaving a lost report to the resync", async () => {
    const event = opened();
    await run(event, "same");
    notified = [];

    await run(event, "same");

    expect(await jobs()).toHaveLength(1);
    expect(notified).toEqual([]);
  });
});

it("ignores an event from an installation it does not know", async () => {
  await run(opened({ installation: "999" }));
  expect(await jobs()).toEqual([]);
});

it("ignores an uninstall", async () => {
  await run({ type: "uninstalled", installation: "556" });
  expect(await jobs()).toEqual([]);
});
