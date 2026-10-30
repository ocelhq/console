import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  DeploymentKind,
  DeploymentService,
  EnvironmentEventKind,
  EnvironmentEventSchema,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { ProjectService } from "@console/connectors/gen/console/v1/project_pb";
import { db } from "@console/db";
import { deployment, environmentEvent, type Job, job } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { envKeyStore, type GitProvider, type GitRuntime, gitStore } from "@console/git";
import { deployIn, type RunnerCalls } from "@console/jobs";
import { eq } from "drizzle-orm";
import { createLocalJWKSet } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestSessionWithOrganization } from "../../../test/auth-harness";
import {
  deploymentRecord,
  projectIn,
  serviceClient,
  TRACE_ID,
} from "../../../test/connect-harness";
import { AUDIENCE, githubActions } from "../../pipelines/testing";

const jobInsert = vi.hoisted(() => ({ fails: false }));

vi.mock("@console/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@console/jobs")>();
  return {
    ...actual,
    recordReportedJob: (...args: Parameters<typeof actual.recordReportedJob>) => {
      if (jobInsert.fails) throw new Error("the job was not stored");
      return actual.recordReportedJob(...args);
    },
  };
});

const noRunner: RunnerCalls = {
  start: async () => {
    throw new Error("no runner in this test");
  },
  get: async () => {
    throw new Error("no runner in this test");
  },
  cancel: async () => {
    throw new Error("no runner in this test");
  },
};

const HEAD = "c".repeat(40);
const RUN_URL = "https://github.com/acme/web/actions/runs/9001/attempts/2";
const store = gitStore(envKeyStore(randomBytes(32).toString("base64")));
const git = {
  store,
  providerFor: () =>
    ({
      async pullRequest() {
        return { headSha: HEAD, mergeCommitSha: "d".repeat(40) };
      },
    }) as unknown as GitProvider,
} as unknown as GitRuntime;

let session: Awaited<ReturnType<typeof createTestSessionWithOrganization>>;
let gha: Awaited<ReturnType<typeof githubActions>>;
let projectId = "";
let notified: Job[] = [];
let installationId = "";

function client(token: string) {
  return serviceClient(DeploymentService, token, {
    notify: async (changed) => {
      notified.push(changed);
    },
    pipelineKeys: { keys: createLocalJWKSet(gha.keys), audience: AUDIENCE },
    git: () => git,
  });
}

const preview = (id = TRACE_ID) =>
  deploymentRecord({
    id,
    kind: DeploymentKind.PREVIEW_UP,
    environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity: "pr-7" },
    promotion: { id: "prm-7", seq: 1n },
    source: { commit: "d".repeat(40), branch: "feat/x" },
    trigger: { kind: 1, actor: "someone-else" },
    ci: { name: "spoofed", repo: "evil/repo", runUrl: "https://evil.example" },
  });

const removed = () =>
  create(EnvironmentEventSchema, {
    id: "1".repeat(32),
    kind: EnvironmentEventKind.PREVIEW_REMOVED,
    environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity: "pr-7" },
    at: timestampFromDate(new Date("2026-01-02T00:00:00.000Z")),
    source: { branch: "feat/x" },
  });

async function refusal(call: Promise<unknown>) {
  return ConnectError.from(
    await call.then(
      () => undefined,
      (thrown: unknown) => thrown,
    ),
  );
}

async function jobs() {
  return db.select().from(job).where(eq(job.projectId, projectId));
}

beforeAll(async () => {
  await setupTestDatabase();
  gha = await githubActions();
  session = await createTestSessionWithOrganization();
  const appRowId = `app-${crypto.randomUUID()}`;
  await store.createOrganizationApp({
    id: appRowId,
    organizationId: session.organization.id,
    kind: "github",
    appId: appRowId,
    slug: "mine",
    privateKey: "k",
    webhookSecret: "w",
    clientId: "c",
    clientSecret: "cs",
  });
  const bound = await store.bindInstallation({
    gitAppId: appRowId,
    organizationId: session.organization.id,
    externalId: crypto.randomUUID(),
    account: "acme",
  });
  if (bound === "claimed") throw new Error("claimed");
  installationId = bound.id;
});

beforeEach(async () => {
  projectId = await projectIn(session.organization.id, `ci-${crypto.randomUUID()}`);
  await store.linkProjectRepo({
    projectId,
    organizationId: session.organization.id,
    installationId,
    repo: { id: "1234", fullName: "acme/web", defaultBranch: "main", ownerId: "42" },
  });
  await deployIn(
    projectId,
    { mode: "ci", by: null },
    { runners: noRunner, notify: async () => {} },
  );
  notified = [];
  jobInsert.fails = false;
});

afterAll(async () => {
  await session.cleanup();
});

describe("a deployment a trusted pipeline reports", () => {
  it("is stored as the run's, whatever the report says triggered it", async () => {
    await client(await gha.sign()).report({ projectId, deployment: preview() });

    const [row] = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
    expect(row?.trigger).toEqual({
      kind: "ci",
      actor: "octocat",
      ci: { provider: "github-actions", repo: "acme/web", url: RUN_URL, pr: 7 },
    });
    expect(row?.principal).toMatchObject({ kind: "pipeline" });
  });

  it("becomes a finished preview job the git sync is told about", async () => {
    await client(await gha.sign()).report({ projectId, deployment: preview() });

    const made = await jobs();
    expect(made).toMatchObject([
      {
        kind: "preview-up",
        status: "done",
        pr: 7,
        sha: HEAD,
        deploymentId: TRACE_ID,
        runUrl: RUN_URL,
      },
    ]);
    expect(notified.map((changed) => changed.id)).toEqual(made.map((row) => row.id));
  });

  it("is accepted again when retried with a fresh token, and stays one job", async () => {
    await client(await gha.sign()).report({ projectId, deployment: preview() });
    await client(await gha.sign()).report({ projectId, deployment: preview() });

    expect(
      await db.select().from(deployment).where(eq(deployment.projectId, projectId)),
    ).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("leaves its token unspent when protovalidate refuses the request", async () => {
    const token = await gha.sign();

    const error = await refusal(
      client(token).report({ projectId, deployment: preview("not-a-trace-id") }),
    );

    expect(error.code).toBe(Code.InvalidArgument);
    await client(token).report({ projectId, deployment: preview() });
    expect(await jobs()).toHaveLength(1);
  });

  it("is not recorded, and leaves its token unspent, when its job is not stored", async () => {
    const token = await gha.sign();
    jobInsert.fails = true;

    await refusal(client(token).report({ projectId, deployment: preview() }));

    expect(await db.select().from(deployment).where(eq(deployment.projectId, projectId))).toEqual(
      [],
    );
    jobInsert.fails = false;
    await client(token).report({ projectId, deployment: preview() });
    expect(await jobs()).toHaveLength(1);
  });

  it("is refused when a pull request run reports production", async () => {
    const error = await refusal(
      client(await gha.sign()).report({ projectId, deployment: deploymentRecord() }),
    );

    expect(error.code).toBe(Code.PermissionDenied);
    expect(await jobs()).toEqual([]);
  });

  it("is refused into a project that does not trust the pipeline", async () => {
    const other = await projectIn(session.organization.id, `other-${crypto.randomUUID()}`);

    const error = await refusal(
      client(await gha.sign()).report({ projectId: other, deployment: preview() }),
    );

    expect(error.code).toBe(Code.PermissionDenied);
  });

  it("makes no job when reported from a laptop's session", async () => {
    await client(session.token).report({ projectId, deployment: preview() });

    const [row] = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
    expect(row?.principal).toEqual({ kind: "session", userId: session.user.id });
    expect(await jobs()).toEqual([]);
  });
});

describe("an environment event a trusted pipeline reports", () => {
  it("is stored as the run's and becomes a finished removal job", async () => {
    await client(await gha.sign()).recordEnvironmentEvent({ projectId, event: removed() });

    const [row] = await db
      .select()
      .from(environmentEvent)
      .where(eq(environmentEvent.projectId, projectId));
    expect(row?.ci).toEqual({ provider: "github-actions", repo: "acme/web", url: RUN_URL, pr: 7 });
    expect(await jobs()).toMatchObject([{ kind: "preview-rm", status: "done", pr: 7 }]);
  });
});

describe("a GitHub Actions token", () => {
  it("is no session for any other method", async () => {
    const error = await refusal(serviceClient(ProjectService, await gha.sign()).list({}));

    expect(error.code).toBe(Code.Unauthenticated);
  });
});
