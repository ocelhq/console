import { randomBytes } from "node:crypto";
import { db } from "@console/db";
import { type Job, job, organization, project, projectRepo } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, type GitProvider, gitStore, type PullRequestHead } from "@console/git";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  notifyReported,
  planReportedJob,
  type ReportedDeployment,
  type ReportedEvent,
  type ReportedFromCi,
  recordReportedJob,
} from "./reported";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const appRowId = `app-${suffix}`;
const projectId = `p-${suffix}`;
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));
const sha = "c".repeat(40);
const RUN_URL = "https://github.com/acme/web/actions/runs/9/attempts/1";
const startedAt = new Date("2026-10-27T10:00:00.000Z");
const finishedAt = new Date("2026-10-27T10:03:00.000Z");

const HEAD = "c".repeat(40);
const MERGE = "m".repeat(40);
let pulls = new Map<number, PullRequestHead>();
const git = {
  store,
  providerFor: () =>
    ({
      async pullRequest(_installation: unknown, _repo: unknown, pr: number) {
        return pulls.get(pr);
      },
    }) as unknown as GitProvider,
};

async function reportedFromCi(
  reported: ReportedFromCi,
  notifyChange: (changed: Job) => Promise<void>,
) {
  const planned = await planReportedJob(reported, git);
  const made = await db.transaction((tx) => recordReportedJob(tx, planned));
  await notifyReported(made, notifyChange);
  return made;
}

let notified: Job[] = [];
const notify = async (changed: Job) => {
  notified.push(changed);
};

const preview = (over: Partial<ReportedDeployment> = {}): ReportedDeployment => ({
  deploymentId: `trace-${crypto.randomUUID()}`,
  kind: "preview-up",
  tier: "preview",
  outcome: "succeeded",
  error: null,
  git: { sha, branch: "feat/x", dirty: false },
  startedAt,
  deployedAt: finishedAt,
  ...over,
});

const removal = (over: Partial<ReportedEvent> = {}): ReportedEvent => ({
  deploymentId: `event-${crypto.randomUUID()}`,
  kind: "preview-removed",
  tier: "preview",
  git: { sha, branch: "feat/x", dirty: false },
  occurredAt: finishedAt,
  ...over,
});

const fromCi = { projectId, repositoryId: "1234", pr: 7, runUrl: RUN_URL };

async function jobs() {
  return db.select().from(job).where(eq(job.projectId, projectId));
}

async function deploysIn(mode: "runners" | "ci") {
  await db.update(projectRepo).set({ deploys: mode }).where(eq(projectRepo.projectId, projectId));
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
  await deploysIn("ci");
  notified = [];
  pulls = new Map([[7, { headSha: HEAD, mergeCommitSha: MERGE }]]);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("a preview CI reports", () => {
  it("is a finished preview job of the run's pull request, which goes to the git sync", async () => {
    const reported = preview();

    await reportedFromCi({ ...fromCi, deployment: reported }, notify);

    const made = await jobs();
    expect(made).toMatchObject([
      {
        kind: "preview-up",
        status: "done",
        pr: 7,
        sha,
        branch: "feat/x",
        deploymentId: reported.deploymentId,
        error: null,
        runUrl: RUN_URL,
        runnerId: null,
        dedupeKey: `report:${reported.deploymentId}`,
        eventAt: startedAt,
        claimedAt: startedAt,
        startedAt,
        finishedAt,
      },
    ]);
    expect(notified.map((changed) => changed.id)).toEqual(made.map((row) => row.id));
  });

  it("is a failed job carrying the error when the deploy failed", async () => {
    await reportedFromCi(
      { ...fromCi, deployment: preview({ outcome: "failed", error: "build broke" }) },
      notify,
    );

    expect(await jobs()).toMatchObject([{ status: "failed", error: "build broke" }]);
  });

  it("is one job however often the report is retried", async () => {
    const reported = preview();

    await reportedFromCi({ ...fromCi, deployment: reported }, notify);
    await reportedFromCi({ ...fromCi, deployment: reported }, notify);

    expect(await jobs()).toHaveLength(1);
    expect(notified).toHaveLength(1);
  });

  it("is no job when the run belongs to no pull request", async () => {
    await reportedFromCi({ ...fromCi, pr: undefined, deployment: preview() }, notify);

    expect(await jobs()).toEqual([]);
  });

  it("is a removal job when the preview is removed", async () => {
    const event = removal();

    await reportedFromCi({ ...fromCi, event }, notify);

    expect(await jobs()).toMatchObject([
      {
        kind: "preview-rm",
        status: "done",
        pr: 7,
        runUrl: RUN_URL,
        dedupeKey: `report:${event.deploymentId}`,
        eventAt: finishedAt,
        finishedAt,
      },
    ]);
  });
});

describe("the commit of a preview CI reports", () => {
  const built = async (commit: string) => {
    await reportedFromCi(
      { ...fromCi, deployment: preview({ git: { sha: commit, branch: "feat/x", dirty: false } }) },
      notify,
    );
    return (await jobs())[0]?.sha;
  };

  it("is kept when it is the pull request's head", async () => {
    expect(await built(HEAD)).toBe(HEAD);
  });

  it("is the pull request's head when the run built GitHub's test merge commit", async () => {
    expect(await built(MERGE)).toBe(HEAD);
  });

  it("is none when the pull request does not have it, so only the comment shows the run", async () => {
    expect(await built("e".repeat(40))).toBeNull();
  });
});

describe("a production deploy CI reports", () => {
  it("is a finished deploy job of no pull request", async () => {
    const reported = preview({
      kind: "deploy",
      tier: "production",
      git: { sha, branch: "main", dirty: false },
    });

    await reportedFromCi({ ...fromCi, pr: undefined, deployment: reported }, notify);

    expect(await jobs()).toMatchObject([
      { kind: "deploy", status: "done", pr: 0, sha, branch: "main", runUrl: RUN_URL },
    ]);
  });

  it("is no job for a rollback or a destroyed environment", async () => {
    await reportedFromCi(
      { ...fromCi, pr: undefined, deployment: preview({ kind: "rollback", tier: "production" }) },
      notify,
    );
    await reportedFromCi(
      { ...fromCi, pr: undefined, event: removal({ kind: "destroyed", tier: "production" }) },
      notify,
    );

    expect(await jobs()).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe("a report the git sync does not follow", () => {
  it("makes no job for a project whose deploys run on the console's runners", async () => {
    await deploysIn("runners");

    await reportedFromCi({ ...fromCi, deployment: preview() }, notify);

    expect(await jobs()).toEqual([]);
  });

  it("makes no job when the run's repository is not the project's linked one", async () => {
    await reportedFromCi({ ...fromCi, repositoryId: "999", deployment: preview() }, notify);

    expect(await jobs()).toEqual([]);
  });
});

describe("a job change the git sync never heard of", () => {
  it("still leaves the job for the resync", async () => {
    await reportedFromCi({ ...fromCi, deployment: preview() }, async () => {
      throw new Error("the queue is down");
    });

    expect(await jobs()).toHaveLength(1);
  });
});
