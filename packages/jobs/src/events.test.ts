import { randomBytes } from "node:crypto";
import { JobState, RunnerService } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import {
  deployment,
  endpoint,
  type Job,
  job,
  organization,
  project,
  projectRepo,
  runnerBinding,
} from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, type GitEvent, gitStore } from "@console/git";
import { pg } from "@console/infra";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGitEvent, toWire } from "./events";
import { type FakeRunner, fakeRunner } from "./fake-runner";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const projects = [`p1-${suffix}`, `p2-${suffix}`];
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));
const repo = { id: "1234", fullName: "acme/web", defaultBranch: "main", ownerId: "42" };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 10, minute));
const sha = (c: string) => c.repeat(40);

const RUNNER = "0b7f3c52-5d2a-4a8e-9a43-3c1f1d0e9a11";

const offered = vi.hoisted(() => ({ cloud: false }));

vi.mock("../../endpoints/src/offer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../endpoints/src/offer")>()),
  readCloudOffer: () =>
    offered.cloud
      ? {
          apiUrl: "https://cloud.example.test/api",
          providerUrl: "",
          audience: "ocel-cloud",
          version: "",
        }
      : undefined,
}));

afterEach(() => {
  offered.cloud = false;
});

let notified: Job[] = [];
let runner: FakeRunner = fakeRunner();
let configs: Record<string, string> = {};
let reads: string[] = [];
const deps = {
  store,
  readFile: async (
    _app: string,
    _installation: unknown,
    _repo: unknown,
    file: { ref: string; path: string },
  ) => {
    reads.push(`${file.ref}:${file.path}`);
    return configs[`${file.ref}:${file.path}`] ?? configs[`*:${file.path}`];
  },
  get runners() {
    return runner;
  },
  gitToken: async () => "ghs_test",
  notify: async (queued: Job) => {
    notified.push(queued);
  },
};

async function bind(projectId: string, tier: "production" | "preview", credentials = true) {
  await db
    .insert(runnerBinding)
    .values({ projectId, tier, runner: "endpoint", endpointId: RUNNER, credentials })
    .onConflictDoUpdate({
      target: [runnerBinding.projectId, runnerBinding.tier],
      set: { credentials },
    });
}

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
  await db.insert(endpoint).values({
    id: RUNNER,
    organizationId: orgId,
    name: "box",
    vendor: "vps",
    url: "https://box.example.com",
    services: [RunnerService.typeName],
    allowedScopes: ["apps.read", "apps.write"],
  });
  await db
    .insert(project)
    .values(projects.map((id, at) => ({ id, organizationId: orgId, name: id, slug: `s${at}` })));
  await store.linkProjectRepo({
    projectId: projects[0] as string,
    organizationId: orgId,
    installationId: bound.id,
    repo,
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
  await db.delete(deployment).where(inArray(deployment.projectId, projects));
  await db.delete(runnerBinding).where(inArray(runnerBinding.projectId, projects));
  for (const id of projects) {
    await bind(id, "production");
    await bind(id, "preview");
  }
  notified = [];
  runner = fakeRunner();
  configs = { "*:ocel.json": '{ "provider": { "aws": {} } }' };
  reads = [];
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

  it("dispatches a deploy of its commit to the runner bound to production, for each project whose production branch it is", async () => {
    await run(push("main"));

    expect(await jobs()).toMatchObject([
      {
        kind: "deploy",
        tier: "production",
        status: "queued",
        sha: sha("b"),
        branch: "main",
        pr: 0,
        runnerId: RUNNER,
        eventAt: at(0),
      },
    ]);
    const [row] = await jobs();
    expect(row?.dispatchedAt).not.toBeNull();
    expect(row?.acknowledgedAt).not.toBeNull();
    expect(await jobs(projects[1])).toEqual([]);
    expect(notified.map((n) => n.kind)).toEqual(["deploy"]);
    expect(runner.started).toHaveLength(1);
    expect(runner.started[0]?.request.source).toEqual({
      case: "gitSource",
      value: expect.objectContaining({
        cloneUrl: "https://github.com/acme/web.git",
        commit: sha("b"),
        token: "ghs_test",
      }),
    });
  });

  it("queues a newer push behind the deploy still running, and dispatches it once that one ends", async () => {
    await run(push("main", false, 0, "b"));
    await run(push("main", false, 1, "c"));

    const [first, second] = await jobs();
    expect(second).toMatchObject({ sha: sha("c"), status: "queued", dispatchedAt: null });
    expect(runner.started).toHaveLength(1);
    expect(first?.id).toBe(runner.started[0]?.job.jobId);
  });

  it("cancels an older push still held at the console, and ends its deployment, while the running one runs on", async () => {
    await run(push("main", false, 0, "b"));
    await run(push("main", false, 1, "c"));
    await run(push("main", false, 2, "d"));

    expect((await jobs()).map((j) => [j.sha, j.status, j.dispatchedAt === null])).toEqual([
      [sha("b"), "queued", false],
      [sha("c"), "canceled", true],
      [sha("d"), "queued", true],
    ]);
    const [, held] = await jobs();
    const [ended] = await db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, held?.deploymentId ?? ""));
    expect(ended).toMatchObject({ outcome: "canceled", outcomeBy: "console" });
    expect(ended?.deployedAt).not.toBeNull();
    expect(runner.canceled).toEqual([]);
  });

  it("deploys a project whose config at the pushed commit names no provider on Ocel Cloud's runner, with no binding", async () => {
    offered.cloud = true;
    await db.delete(runnerBinding).where(eq(runnerBinding.projectId, projects[0] as string));
    configs = { [`${sha("b")}:ocel.json`]: '{ "slug": "s0" }' };

    await run(push("main"));

    expect(await jobs()).toMatchObject([
      { kind: "deploy", status: "queued", runnerId: "ocel-cloud", spec: { provider: "" } },
    ]);
    expect(reads).toContain(`${sha("b")}:ocel.json`);
  });

  it("asks for a runner for a project whose config names a provider and binds none", async () => {
    offered.cloud = true;
    await db.delete(runnerBinding).where(eq(runnerBinding.projectId, projects[0] as string));

    await run(push("main"));

    expect(await jobs()).toMatchObject([
      { status: "failed", error: "bind a runner to production" },
    ]);
  });

  it("says why when the config at the commit is one it cannot read", async () => {
    offered.cloud = true;
    await db.delete(runnerBinding).where(eq(runnerBinding.projectId, projects[0] as string));
    configs = { [`${sha("b")}:ocel.config.ts`]: "export default {}" };

    await run(push("main"));

    const [refused] = await jobs();
    expect(refused?.status).toBe("failed");
    expect(refused?.error).toMatch(/^bind a runner to production \(.*ocel\.config\.ts/);
  });

  it("refuses up front a commit whose config names another project's slug", async () => {
    configs = { [`${sha("b")}:ocel.json`]: '{ "slug": "shop", "provider": { "aws": {} } }' };

    await run(push("main"));

    const [refused] = await jobs();
    expect(refused).toMatchObject({ status: "failed", runnerId: null });
    expect(refused?.error).toContain("names slug shop");
    expect(refused?.error).toContain("linked to project s0");
    expect(runner.started).toEqual([]);
  });

  it("runs on the bound runner a project whose config it cannot read", async () => {
    configs = { [`${sha("b")}:ocel.config.ts`]: "export default {}" };

    await run(push("main"));

    expect(await jobs()).toMatchObject([{ status: "queued", runnerId: RUNNER }]);
    expect((await jobs())[0]?.spec?.provider).toBeUndefined();
  });

  it("is not held back by a preview removal run from a laptop", async () => {
    await db.insert(job).values({
      id: crypto.randomUUID(),
      projectId: projects[0] as string,
      kind: "preview-rm",
      tier: "preview",
      status: "done",
      pr: 0,
      dedupeKey: "laptop",
      eventAt: at(30),
      spec: {
        source: { sourceId: "c".repeat(64) },
        preview: { name: "feature", persistent: false },
      },
      finishedAt: at(30),
    });

    await run(push("main", false, 31));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-rm", "done"],
      ["deploy", "queued"],
    ]);
  });

  it("dispatches nothing and records why when production has no runner bound", async () => {
    await db
      .delete(runnerBinding)
      .where(
        and(
          eq(runnerBinding.projectId, projects[0] as string),
          eq(runnerBinding.tier, "production"),
        ),
      );

    await run(push("main"));

    expect(await jobs()).toMatchObject([
      { kind: "deploy", status: "failed", error: "bind a runner to production" },
    ]);
    expect(runner.started).toEqual([]);
  });

  it("dispatches nothing to a bound runner that gets no target credentials", async () => {
    await bind(projects[0] as string, "production", false);

    await run(push("main"));

    expect(await jobs()).toMatchObject([
      { status: "failed", error: expect.stringMatching(/credentials/) },
    ]);
    expect(runner.started).toEqual([]);
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
  it("dispatches a preview for every project linked to the repo", async () => {
    await run(opened());

    for (const id of projects) {
      expect(await jobs(id)).toMatchObject([
        { kind: "preview-up", tier: "preview", status: "queued", pr: 7, sha: sha("a") },
      ]);
    }
    expect(runner.started.map((started) => started.request.preview?.name)).toEqual([
      "pr-7",
      "pr-7",
    ]);
  });

  it("queues no preview for a fork, which no one approved to run code", async () => {
    await run(opened({ fork: true }));
    await run(synced({ fork: true }));

    expect(await jobs()).toEqual([]);
  });

  it("cancels the preview of an older commit at its runner and dispatches the new one", async () => {
    await run(opened());
    await run(synced({ sha: sha("c"), at: at(1) }));

    expect((await jobs()).map((j) => [j.sha, j.status, j.cancelRequested])).toEqual([
      [sha("a"), "canceled", true],
      [sha("c"), "queued", false],
    ]);
    expect(runner.canceled).toHaveLength(2);
    expect(runner.started.map((started) => started.request.git?.commit)).toContain(sha("c"));
  });

  it("holds the new preview until the runner has stopped the one it replaces", async () => {
    await run(opened());
    const [first] = await jobs();
    runner.cancel = async (job) => {
      runner.canceled.push(job.jobId);
      return runner.jobs.get(job.jobId);
    };

    await run(synced({ sha: sha("c"), at: at(1) }));

    expect((await jobs()).map((j) => [j.sha, j.status, j.dispatchedAt === null])).toEqual([
      [sha("a"), "queued", false],
      [sha("c"), "queued", true],
    ]);
    expect(runner.canceled).toContain(first?.id);
  });

  it("leaves another pull request's jobs alone", async () => {
    await run(opened({ pr: 8 }));
    await run(opened());

    expect((await jobs()).map((j) => [j.pr, j.status])).toEqual([
      [8, "queued"],
      [7, "queued"],
    ]);
  });

  it("dispatches a removal of the commit its preview ran when it closes", async () => {
    await run(opened());
    await db.update(job).set({ status: "done" }).where(inArray(job.projectId, projects));

    await run(closed(2));

    expect((await jobs()).map((j) => [j.kind, j.status, j.sha])).toEqual([
      ["preview-up", "done", sha("a")],
      ["preview-rm", "queued", sha("a")],
    ]);
    const removal = runner.started.at(-1)?.request;
    expect(removal?.preview?.name).toBe("pr-7");
    expect(removal?.source.case).toBe("gitSource");
  });

  it("removes a preview by the provider its preview job learned, reading no config again", async () => {
    await run(opened());
    await db.update(job).set({ status: "done" }).where(inArray(job.projectId, projects));
    reads = [];

    await run(closed(2));

    expect(reads).toEqual([]);
    expect((await jobs()).map((j) => [j.kind, j.spec?.provider])).toEqual([
      ["preview-up", "aws"],
      ["preview-rm", "aws"],
    ]);
  });

  it("dispatches a removal of a preview its CI deployed, which no runner ever ran", async () => {
    await db.insert(job).values({
      id: crypto.randomUUID(),
      projectId: projects[0] as string,
      kind: "preview-up",
      tier: "preview",
      status: "done",
      pr: 7,
      lane: "feature-x",
      sha: sha("e"),
      dedupeKey: "report:ci",
      eventAt: at(0),
      runUrl: "https://github.com/acme/web/actions/runs/1",
      finishedAt: at(0),
    });

    await run(closed(2));

    expect((await jobs()).map((j) => [j.kind, j.status, j.sha, j.lane])).toEqual([
      ["preview-up", "done", sha("e"), "feature-x"],
      ["preview-rm", "queued", sha("e"), "feature-x"],
    ]);
    expect(runner.started.at(-1)?.request.preview?.name).toBe("feature-x");
  });

  it("reports what it replaced, so a canceled preview stops saying it waits", async () => {
    await run(opened());
    notified = [];

    await run(synced({ sha: sha("c"), at: at(1) }));

    expect(
      notified.filter((n) => n.projectId === projects[0]).map((n) => [n.sha, n.status]),
    ).toEqual([
      [sha("a"), "queued"],
      [sha("a"), "canceled"],
      [sha("c"), "queued"],
    ]);
  });

  it("closes a pull request whose preview never reached a runner without dispatching a removal", async () => {
    await db.delete(runnerBinding).where(inArray(runnerBinding.projectId, projects));
    await run(opened());
    notified = [];

    await run(closed(1, true));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-up", "failed"],
      ["preview-rm", "done"],
    ]);
    expect(runner.started).toEqual([]);
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
      ["preview-rm", "queued"],
    ]);
  });

  it("queues no preview for an update older than the one it already queued", async () => {
    await run(synced({ sha: sha("d"), at: at(2) }));
    await run(synced({ sha: sha("c"), at: at(1) }));

    expect((await jobs()).map((j) => [j.sha, j.status])).toEqual([[sha("d"), "queued"]]);
  });

  it("dispatches a preview again when a closed pull request reopens", async () => {
    await run(opened());
    await db.update(job).set({ status: "done" }).where(inArray(job.projectId, projects));
    await run(closed(1));
    await db
      .update(job)
      .set({ status: "done" })
      .where(and(inArray(job.projectId, projects), eq(job.kind, "preview-rm")));
    await run(opened({ reopened: true, at: at(2) }));

    expect((await jobs()).map((j) => [j.kind, j.status])).toEqual([
      ["preview-up", "done"],
      ["preview-rm", "done"],
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
    expect(
      runner.started.filter((s) => s.job.jobId === (runner.started[0]?.job.jobId ?? "")),
    ).toHaveLength(1);
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

it("marks the runner's view of a dispatched job on the row", async () => {
  runner.start = async (job) => {
    runner.set(job.jobId, JobState.RUNNING);
    return runner.jobs.get(job.jobId);
  };
  await run(opened());

  expect((await jobs()).map((j) => j.status)).toEqual(["running"]);
});

describe("a project whose deploys run in its own CI", () => {
  it("has nothing queued for it by a push or a pull request, while the runners' projects do", async () => {
    await db
      .update(projectRepo)
      .set({ deploys: "ci" })
      .where(eq(projectRepo.projectId, projects[0] as string));
    try {
      await run(
        {
          type: "push",
          installation: "556",
          repo,
          branch: "main",
          sha: sha("b"),
          deleted: false,
          at: at(0),
        },
        "push-ci",
      );
      await run(opened(), "opened-ci");
      await run(closed(5), "closed-ci");

      expect(await jobs()).toEqual([]);
      expect((await jobs(projects[1])).map((row) => row.kind)).toEqual([
        "preview-up",
        "preview-rm",
      ]);
    } finally {
      await db
        .update(projectRepo)
        .set({ deploys: "runners" })
        .where(eq(projectRepo.projectId, projects[0] as string));
    }
  });
});
