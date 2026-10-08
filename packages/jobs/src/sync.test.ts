import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { deployment, type Job, job, organization, project, projectRepo } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, type GitProvider, gitStore } from "@console/git";
import { pg } from "@console/infra";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncJob } from "./sync";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const web = `web-${suffix}`;
const api = `api-${suffix}`;
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));
const repo = { id: "1234", fullName: "acme/web", defaultBranch: "main" };
const repoRef = { id: "1234", fullName: "acme/web" };
const installation = { externalId: "556" };
const sha = (c: string) => c.repeat(40);
const MARKER = "<!-- ocel-preview -->";

type Call = [method: string, ...args: unknown[]];
let calls: Call[] = [];
const provider = {
  async setStatus(...args: unknown[]) {
    calls.push(["setStatus", ...args]);
  },
  async upsertComment(...args: unknown[]) {
    calls.push(["upsertComment", ...args]);
  },
  async upsertDeployment(...args: unknown[]) {
    calls.push(["upsertDeployment", ...args]);
  },
} as unknown as GitProvider;
const deps = { store, providerFor: () => provider };

let serial = 0;
let installationRowId = "";
async function queued(
  over: Partial<typeof job.$inferInsert> & { projectId: string },
): Promise<Job> {
  serial += 1;
  const [row] = await db
    .insert(job)
    .values({
      id: `job-${suffix}-${serial}`,
      kind: "preview-up",
      pr: 7,
      sha: sha("a"),
      dedupeKey: `d-${serial}`,
      eventAt: new Date(),
      createdAt: new Date(Date.now() + serial * 1000),
      ...over,
    })
    .returning();
  if (!row) throw new Error("not inserted");
  return row;
}

function arg<T>(call: Call | undefined): T {
  return call?.[3] as T;
}

const statusOf = (call: Call | undefined) =>
  (call?.[3] as { state: string; context: string })?.state;

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
  installationRowId = bound.id;
  await db.insert(project).values([
    { id: web, organizationId: orgId, name: "Web", slug: "web" },
    { id: api, organizationId: orgId, name: "Api", slug: "api" },
  ]);
  for (const projectId of [web, api]) {
    await store.linkProjectRepo({
      projectId,
      organizationId: orgId,
      installationId: bound.id,
      repo,
    });
  }
});

beforeEach(async () => {
  await db.delete(job).where(inArray(job.projectId, [web, api]));
  await db.delete(deployment).where(inArray(deployment.projectId, [web, api]));
  calls = [];
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("a production deploy", () => {
  it.each([
    ["queued", "pending"],
    ["claimed", "pending"],
    ["running", "pending"],
    ["done", "success"],
    ["failed", "failure"],
  ] as const)(
    "is a %s commit status of %s on its commit, and nothing else",
    async (status, state) => {
      const row = await queued({ projectId: web, kind: "deploy", pr: 0, status });

      await syncJob(row.id, deps);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject([
        "setStatus",
        installation,
        repoRef,
        { sha: sha("a"), state, context: "ocel/web/deploy" },
      ]);
    },
  );
});

describe("a preview", () => {
  it("reports a deploying preview on the commit, the pull request and the environment", async () => {
    const row = await queued({ projectId: web, status: "running" });

    await syncJob(row.id, deps);

    expect(calls.map((call) => call[0])).toEqual([
      "setStatus",
      "upsertComment",
      "upsertDeployment",
    ]);
    expect(statusOf(calls[0])).toBe("pending");
    expect(calls[1]?.[3]).toMatchObject({ pr: 7, marker: MARKER });
    expect(arg<{ body: string }>(calls[1]).body).toContain(MARKER);
    expect(calls[2]?.[3]).toMatchObject({
      environment: "preview/pr-7/web",
      state: "in_progress",
      sha: sha("a"),
    });
  });

  it("links the URL the deployment the job made serves", async () => {
    await db.insert(deployment).values({
      id: `dep-row-${suffix}`,
      projectId: web,
      deploymentId: "dep-1",
      kind: "preview-up",
      tier: "preview",
      environmentIdentity: "pr-7",
      providerName: "vps",
      target: "t",
      outcome: "succeeded",
      trigger: { kind: "git" },
      deployedAt: new Date(),
      trace: [],
      topology: {
        apps: [
          {
            name: "web",
            compute: "container",
            urls: ["https://pr-7.example.com"],
            hostnames: [],
            outcome: "succeeded",
            variables: [],
          },
        ],
        resources: [],
        usages: [],
      },
    });
    const row = await queued({ projectId: web, status: "done", deploymentId: "dep-1" });

    await syncJob(row.id, deps);

    expect(statusOf(calls[0])).toBe("success");
    expect(arg<{ body: string }>(calls[1]).body).toContain("https://pr-7.example.com");
    expect(calls[2]?.[3]).toMatchObject({
      state: "success",
      environmentUrl: "https://pr-7.example.com",
    });
  });

  it("reports a preview waiting for or held by a runner as a queued deployment", async () => {
    for (const status of ["queued", "claimed"] as const) {
      calls = [];
      const row = await queued({ projectId: web, status });

      await syncJob(row.id, deps);

      expect(calls[2]?.[3]).toMatchObject({ environment: "preview/pr-7/web", state: "queued" });
    }
  });

  it("gives each project of a monorepo its own environment", async () => {
    await queued({ projectId: api, status: "done" });
    const row = await queued({ projectId: web, status: "running" });

    await syncJob(row.id, deps);

    expect(calls.filter((call) => call[0] === "upsertDeployment").map((call) => call[3])).toEqual([
      { environment: "preview/pr-7/web", state: "in_progress", sha: sha("a") },
    ]);
  });

  it("reports a failed preview as failed", async () => {
    const row = await queued({ projectId: web, status: "failed", error: "build failed" });

    await syncJob(row.id, deps);

    expect(statusOf(calls[0])).toBe("failure");
    expect(calls[2]?.[3]).toMatchObject({ state: "failure" });
  });

  it("lists every project of the repo in the one comment, each at its latest job", async () => {
    await queued({ projectId: api, status: "done", sha: sha("1") });
    await queued({ projectId: api, status: "queued", sha: sha("2") });
    const row = await queued({ projectId: web, status: "running" });

    await syncJob(row.id, deps);

    const body = arg<{ body: string }>(calls[1]).body;
    expect(body).toContain("Web");
    expect(body).toContain("Api");
    expect(body).toContain(sha("2").slice(0, 7));
    expect(body).not.toContain(sha("1").slice(0, 7));
  });

  it("describes a stale job by the pull request's latest state", async () => {
    const stale = await queued({ projectId: web, status: "done", sha: sha("1") });
    await queued({ projectId: web, status: "running", sha: sha("2") });

    await syncJob(stale.id, deps);

    expect(arg<{ body: string }>(calls[1]).body).toContain(sha("2").slice(0, 7));
    expect(calls[2]?.[3]).toMatchObject({ state: "in_progress", sha: sha("2") });
  });

  it("marks the environment inactive and the comment removed once the preview is removed", async () => {
    const row = await queued({
      projectId: web,
      kind: "preview-rm",
      sha: null,
      status: "done",
      claimedAt: new Date(),
    });

    await syncJob(row.id, deps);

    expect(calls.map((call) => call[0])).toEqual(["upsertComment", "upsertDeployment"]);
    expect(calls[1]?.[3]).toEqual({ environment: "preview/pr-7/web", state: "inactive" });
    expect(arg<{ body: string }>(calls[0]).body).toContain("Removed");
  });

  it("says a pull request closed before its preview ran is closed, and its environment inactive", async () => {
    await queued({ projectId: web, status: "canceled" });
    const row = await queued({ projectId: web, kind: "preview-rm", sha: null, status: "done" });

    await syncJob(row.id, deps);

    expect(arg<{ body: string }>(calls[0]).body).toContain("Closed");
    expect(calls[1]?.[3]).toEqual({ environment: "preview/pr-7/web", state: "inactive" });
  });

  it("ends a canceled preview's commit status, and reports the job that replaced it", async () => {
    const row = await queued({ projectId: web, status: "canceled", sha: sha("1") });
    await queued({ projectId: web, status: "queued", sha: sha("2") });

    await syncJob(row.id, deps);

    expect(calls[0]).toMatchObject([
      "setStatus",
      installation,
      repoRef,
      { sha: sha("1"), state: "error", context: "ocel/web/preview", description: "Canceled" },
    ]);
    expect(arg<{ body: string }>(calls[1]).body).toContain(sha("2").slice(0, 7));
    expect(calls[2]?.[3]).toMatchObject({ state: "queued", sha: sha("2") });
  });

  it("leaves a canceled preview's commit to the job that took it over at the same commit", async () => {
    const row = await queued({ projectId: web, status: "canceled" });
    await queued({ projectId: web, status: "queued" });

    await syncJob(row.id, deps);

    expect(calls.map((call) => call[0])).toEqual(["upsertComment", "upsertDeployment"]);
  });
});

describe("what was reported", () => {
  it("is recorded at the revision the sync read", async () => {
    const row = await queued({ projectId: web, status: "running", revision: 3 });

    await syncJob(row.id, deps);

    const [after] = await db.select().from(job).where(eq(job.id, row.id));
    expect(after?.syncedRevision).toBe(3);
  });

  it("is recorded for a job there is nothing to report to, so it is not tried again", async () => {
    const row = await queued({ projectId: web, status: "running", revision: 2 });
    await db.delete(projectRepo).where(eq(projectRepo.projectId, web));

    await syncJob(row.id, deps);

    const [after] = await db.select().from(job).where(eq(job.id, row.id));
    expect(after?.syncedRevision).toBe(2);
    await store.linkProjectRepo({
      projectId: web,
      organizationId: orgId,
      installationId: installationRowId,
      repo,
    });
  });
});

describe("a job nothing is owed for", () => {
  it("reports nothing for a job that is gone or whose project left the repo", async () => {
    await syncJob("missing", deps);
    await db.delete(job).where(eq(job.projectId, web));
    const row = await queued({ projectId: web, status: "running" });
    await db.delete(projectRepo).where(eq(projectRepo.projectId, web));

    await syncJob(row.id, deps);

    expect(calls).toEqual([]);
  });
});
