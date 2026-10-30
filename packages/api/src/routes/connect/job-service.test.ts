import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  DeploymentKind,
  DeploymentService,
  EnvironmentEventKind,
  TriggerKind,
} from "@console/connectors/gen/console/v1/deployment_pb";
import {
  type DispatchJobRequest,
  DispatchJobRequestSchema,
  JobService,
} from "@console/connectors/gen/console/v1/job_pb";
import {
  JobCommand,
  type JobRequest,
  JobSchema,
  JobState,
} from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { deployment, job } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { type RunnerCalls, signJobToken } from "@console/jobs";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../test/auth-harness";
import {
  bindRunnerRow,
  deploymentRecord,
  projectIn,
  serviceClient,
} from "../../../test/connect-harness";

const notRefused = (): ConnectError => {
  throw new Error("the call was not refused");
};
const refusal = (thrown: unknown) => ConnectError.from(thrown);

const RUNNER = "5c1e7d2a-3b4f-4a6e-8d9c-1f2e3a4b5c6d";
const SOURCE = "a".repeat(64);

let started: { jobId: string; request: JobRequest; token: string }[] = [];
let runnerSays = JobState.RUNNING;
const runners: RunnerCalls = {
  async start(dispatched, request, token) {
    started.push({ jobId: dispatched.jobId, request, token });
    return create(JobSchema, { id: dispatched.jobId, state: JobState.QUEUED });
  },
  async get(dispatched) {
    return create(JobSchema, { id: dispatched.jobId, state: runnerSays });
  },
  async cancel(dispatched) {
    return create(JobSchema, { id: dispatched.jobId, state: JobState.CANCELED });
  },
};

function dispatching(
  projectId: string,
  over: Omit<Partial<MessageInitShape<typeof DispatchJobRequestSchema>>, "$typeName"> = {},
): DispatchJobRequest {
  return create(DispatchJobRequestSchema, {
    requestId: crypto.randomUUID().replaceAll("-", ""),
    projectId,
    tier: Tier.PRODUCTION,
    runnerId: RUNNER,
    slug: "web",
    provider: "aws",
    job: {
      command: JobCommand.DEPLOY,
      source: { case: "sourceId", value: SOURCE },
      git: { commit: "abcdef0", branch: "main" },
    },
    ...over,
  });
}

async function bind(projectId: string, tier: "production" | "preview", credentials = true) {
  await bindRunnerRow(projectId, tier, RUNNER, credentials);
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(() => {
  started = [];
  runnerSays = JobState.RUNNING;
});

describe("JobService.Dispatch", () => {
  it("dispatches a deploy to the tier's bound runner and answers the job it started", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      await bind(projectId, "production");
      const client = serviceClient(JobService, session.token, { runners });

      const { job: dispatched } = await client.dispatch(dispatching(projectId));

      expect(dispatched).toMatchObject({
        projectId,
        tier: Tier.PRODUCTION,
        runnerId: RUNNER,
        command: JobCommand.DEPLOY,
        state: JobState.QUEUED,
      });
      expect(dispatched?.deploymentId).toMatch(/^[0-9a-f]{32}$/);
      expect(started.map((s) => s.jobId)).toEqual([dispatched?.id]);
      expect(started[0]?.request.source).toEqual({ case: "sourceId", value: SOURCE });
      const [row] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched?.deploymentId ?? ""));
      expect(row).toMatchObject({ outcome: null, jobId: dispatched?.id, runnerId: RUNNER });
      expect(row?.trigger).toMatchObject({ kind: "cli", remote: { runner: RUNNER } });

      const { job: read } = await client.get({ projectId, jobId: dispatched?.id ?? "" });
      expect(read?.id).toBe(dispatched?.id);
    } finally {
      await session.cleanup();
    }
  });

  it("queues a production deploy behind the tier's other jobs whatever pull request the client names", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      await bind(projectId, "production");

      const { job: dispatched } = await serviceClient(JobService, session.token, {
        runners,
      }).dispatch(
        dispatching(projectId, {
          job: {
            command: JobCommand.DEPLOY,
            source: { case: "sourceId", value: SOURCE },
            git: { commit: "abcdef0", branch: "main", pullRequest: 42 },
          },
        }),
      );

      const [row] = await db
        .select()
        .from(job)
        .where(eq(job.id, dispatched?.id ?? ""));
      expect(row?.pr).toBe(0);
    } finally {
      await session.cleanup();
    }
  });

  it("answers the job a request already dispatched, and starts it once", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      await bind(projectId, "production");
      const client = serviceClient(JobService, session.token, { runners });
      const request = dispatching(projectId);

      const first = await client.dispatch(request);
      const again = await client.dispatch(request);

      expect(again.job?.id).toBe(first.job?.id);
      expect(started).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a tier with no runner bound, for a project that names a provider", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      const error = await serviceClient(JobService, session.token, { runners })
        .dispatch(dispatching(projectId))
        .then(notRefused, refusal);

      expect(error).toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: "bind a runner to production",
      });
      expect(await db.select().from(job).where(eq(job.projectId, projectId))).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a bound runner that gets no credentials before anything builds", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      await bind(projectId, "production", false);

      const error = await serviceClient(JobService, session.token, { runners })
        .dispatch(dispatching(projectId))
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.FailedPrecondition);
      expect(error.rawMessage).toMatch(/credentials/);
      expect(started).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a runner other than the one bound", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      await bind(projectId, "production");

      const error = await serviceClient(JobService, session.token, { runners })
        .dispatch(dispatching(projectId, { runnerId: "ocel-cloud" }))
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.FailedPrecondition);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a slug that is not the project's", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      await bind(projectId, "production");

      const error = await serviceClient(JobService, session.token, { runners })
        .dispatch(dispatching(projectId, { slug: "other" }))
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.FailedPrecondition);
      expect(error.rawMessage).toMatch(/slug is web/);
    } finally {
      await session.cleanup();
    }
  });

  it("lets a member deploy but not destroy the project", async () => {
    const owner = await createTestSessionWithOrganization();
    const member = await createTestSessionWithRole(owner.organization.id, "member");
    try {
      const projectId = await projectIn(owner.organization.id, "web");
      await bind(projectId, "production");
      const client = serviceClient(JobService, member.token, { runners });

      await client.dispatch(dispatching(projectId));
      const error = await client
        .dispatch(
          dispatching(projectId, {
            job: {
              command: JobCommand.PROJECTS_DESTROY,
              source: { case: "sourceId", value: SOURCE },
            },
          }),
        )
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.PermissionDenied);
    } finally {
      await member.cleanup();
      await owner.cleanup();
    }
  });

  it("finds no project of another organization", async () => {
    const session = await createTestSessionWithOrganization();
    const other = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(other.organization.id, "web");
      await bind(projectId, "production");

      const error = await serviceClient(JobService, session.token, { runners })
        .dispatch(dispatching(projectId))
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.NotFound);
    } finally {
      await session.cleanup();
      await other.cleanup();
    }
  });
});

describe("a job reporting its own deployment", () => {
  async function dispatchedDeploy(
    command = JobCommand.DEPLOY,
    tier = Tier.PRODUCTION,
    git?: { commit: string; branch: string },
  ) {
    const session = await createTestSessionWithOrganization();
    const projectId = await projectIn(session.organization.id, "web");
    await bind(projectId, "production");
    await bind(projectId, "preview");
    const preview = command === JobCommand.PREVIEW_UP || command === JobCommand.PREVIEW_RM;
    const { job: dispatched } = await serviceClient(JobService, session.token, {
      runners,
    }).dispatch(
      dispatching(projectId, {
        tier,
        job: {
          command,
          source: { case: "sourceId", value: SOURCE },
          ...(git ? { git } : {}),
          ...(preview ? { preview: { name: "feature" } } : {}),
        },
      }),
    );
    if (!dispatched) throw new Error("nothing dispatched");
    const token = started.at(-1)?.token ?? "";
    return { session, projectId, dispatched, token };
  }

  const starting = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: DeploymentKind.DEPLOY,
    environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
    provider: { name: "aws", region: "us-east-1" },
    target: "aws/123456789012/us-east-1/main",
    startedAt: timestampFromDate(new Date("2026-01-01T00:00:00.000Z")),
    cliVersion: "0.0.3",
    trigger: { kind: TriggerKind.CI, actor: "someone" },
    ...over,
  });

  it("starts and completes the deployment the console dispatched, keeping its trigger", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      const client = serviceClient(DeploymentService, token);

      await client.start({ projectId, deployment: starting(dispatched.deploymentId) });
      const [running] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched.deploymentId));
      expect(running).toMatchObject({
        outcome: null,
        providerName: "aws",
        target: "aws/123456789012/us-east-1/main",
        cliVersion: "0.0.3",
        principal: { kind: "job", jobId: dispatched.id },
      });
      expect(running?.trigger.kind).toBe("cli");

      await client.report({
        projectId,
        deployment: deploymentRecord({ id: dispatched.deploymentId }),
      });
      const rows = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "succeeded", jobId: dispatched.id });
      expect(rows[0]?.trigger.kind).toBe("cli");
    } finally {
      await session.cleanup();
    }
  });

  it("marks its job running as soon as the job's ocel starts the deployment", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      await serviceClient(DeploymentService, token, { runners }).start({
        projectId,
        deployment: starting(dispatched.deploymentId),
      });

      const [row] = await db.select().from(job).where(eq(job.id, dispatched.id));
      expect(row?.status).toBe("running");
    } finally {
      await session.cleanup();
    }
  });

  it("reads the runner when the job reports, and sends the tier's next job once the runner says it ended", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      const { job: next } = await serviceClient(JobService, session.token, { runners }).dispatch(
        dispatching(projectId),
      );
      expect(started.map((s) => s.jobId)).not.toContain(next?.id);
      runnerSays = JobState.SUCCEEDED;

      await serviceClient(DeploymentService, token, { runners }).report({
        projectId,
        deployment: deploymentRecord({ id: dispatched.deploymentId }),
      });

      const [ended] = await db.select().from(job).where(eq(job.id, dispatched.id));
      expect(ended?.status).toBe("done");
      expect(started.map((s) => s.jobId)).toContain(next?.id);
    } finally {
      await session.cleanup();
    }
  });

  it("keeps the console's remote trigger over the runner trigger the job's ocel reports", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      const client = serviceClient(DeploymentService, token, { runners });
      const fromRunner = { kind: TriggerKind.CI, actor: "runner" };
      await client.start({
        projectId,
        deployment: starting(dispatched.deploymentId, {
          trigger: fromRunner,
          ci: { name: "ocel-runner" },
        }),
      });
      await client.report({
        projectId,
        deployment: deploymentRecord({
          id: dispatched.deploymentId,
          trigger: fromRunner,
          ci: { name: "ocel-runner" },
        }),
      });

      const [row] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched.deploymentId));
      expect(row?.trigger).toEqual({
        kind: "cli",
        actor: expect.any(String),
        remote: { runner: RUNNER },
      });
    } finally {
      await session.cleanup();
    }
  });

  it("takes the job's own report over the failure the console wrote when it lost the job", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      await db
        .update(job)
        .set({
          status: "failed",
          error: "The runner no longer knows the job",
          finishedAt: new Date(),
        })
        .where(eq(job.id, dispatched.id));
      await db
        .update(deployment)
        .set({ outcome: "failed", outcomeBy: "console", deployedAt: new Date(), error: "lost" })
        .where(eq(deployment.deploymentId, dispatched.deploymentId));

      await serviceClient(DeploymentService, token).report({
        projectId,
        deployment: deploymentRecord({ id: dispatched.deploymentId }),
      });

      const [reported] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched.deploymentId));
      expect(reported).toMatchObject({ outcome: "succeeded", outcomeBy: "ocel", error: null });
    } finally {
      await session.cleanup();
    }
  });

  it("takes the job's own late report over the success the console wrote without one", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      await db
        .update(deployment)
        .set({ outcome: "succeeded", outcomeBy: "console", deployedAt: new Date() })
        .where(eq(deployment.deploymentId, dispatched.deploymentId));

      await serviceClient(DeploymentService, token).report({
        projectId,
        deployment: deploymentRecord({ id: dispatched.deploymentId }),
      });

      const [reported] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched.deploymentId));
      expect(reported).toMatchObject({ outcome: "succeeded", outcomeBy: "ocel" });
      expect(reported?.topology.apps.length).toBeGreaterThan(0);
    } finally {
      await session.cleanup();
    }
  });

  it("keeps the commit the console dispatched, and what else ocel read of the source", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy(
      JobCommand.DEPLOY,
      Tier.PRODUCTION,
      { commit: "abcdef0", branch: "main" },
    );
    try {
      await serviceClient(DeploymentService, token).report({
        projectId,
        deployment: deploymentRecord({
          id: dispatched.deploymentId,
          source: { commit: "f".repeat(40), branch: "other", dirty: true },
        }),
      });

      const [reported] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched.deploymentId));
      expect(reported?.git).toEqual({ sha: "abcdef0", branch: "main", dirty: false });
      expect(reported?.trigger.kind).toBe("cli");
    } finally {
      await session.cleanup();
    }
  });

  it("is the only reporter of its deployment: a session's report of it is refused", async () => {
    const { session, projectId, dispatched } = await dispatchedDeploy();
    try {
      const error = await serviceClient(DeploymentService, session.token)
        .report({ projectId, deployment: deploymentRecord({ id: dispatched.deploymentId }) })
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.PermissionDenied);
      const [kept] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, dispatched.deploymentId));
      expect(kept?.outcome).toBeNull();
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a deployment other than its own", async () => {
    const { session, projectId, token } = await dispatchedDeploy();
    try {
      const error = await serviceClient(DeploymentService, token)
        .report({ projectId, deployment: deploymentRecord({ id: "f".repeat(32) }) })
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.PermissionDenied);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a deployment of a kind its command does not run", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy();
    try {
      const error = await serviceClient(DeploymentService, token)
        .start({
          projectId,
          deployment: starting(dispatched.deploymentId, {
            kind: DeploymentKind.PREVIEW_UP,
            environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL },
          }),
        })
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.PermissionDenied);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses another project's record", async () => {
    const { session, dispatched, token } = await dispatchedDeploy();
    try {
      const otherProject = await projectIn(session.organization.id, "api");
      const error = await serviceClient(DeploymentService, token)
        .start({ projectId: otherProject, deployment: starting(dispatched.deploymentId) })
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.PermissionDenied);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a deployment from a job that records none, and takes only its own environment event", async () => {
    const { session, projectId, token } = await dispatchedDeploy(
      JobCommand.PREVIEW_RM,
      Tier.PREVIEW,
    );
    try {
      const client = serviceClient(DeploymentService, token);
      const refused = await client
        .report({
          projectId,
          deployment: deploymentRecord({
            kind: DeploymentKind.PREVIEW_UP,
            environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL },
          }),
        })
        .then(notRefused, refusal);
      expect(refused.code).toBe(Code.PermissionDenied);

      const event = (kind: EnvironmentEventKind) => ({
        projectId,
        event: {
          id: crypto.randomUUID().replaceAll("-", ""),
          kind,
          environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity: "feature" },
          at: timestampFromDate(new Date()),
        },
      });
      const destroyed = await client
        .recordEnvironmentEvent(event(EnvironmentEventKind.DESTROYED))
        .then(notRefused, refusal);
      expect(destroyed.code).toBe(Code.PermissionDenied);

      await client.recordEnvironmentEvent(event(EnvironmentEventKind.PREVIEW_REMOVED));
    } finally {
      await session.cleanup();
    }
  });

  it("carries its preview's name, and acts on no other preview", async () => {
    const { session, projectId, dispatched, token } = await dispatchedDeploy(
      JobCommand.PREVIEW_UP,
      Tier.PREVIEW,
    );
    try {
      expect(decodeJwt(token).preview).toBe("feature");
      const client = serviceClient(DeploymentService, token);
      const startingIn = (identity: string) => ({
        projectId,
        deployment: starting(dispatched.deploymentId, {
          kind: DeploymentKind.PREVIEW_UP,
          environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity },
        }),
      });

      const refused = await client.start(startingIn("someone-else")).then(notRefused, refusal);
      expect(refused.code).toBe(Code.PermissionDenied);
      expect(refused.rawMessage).toContain("preview feature");

      await client.start(startingIn("feature"));
      const report = await client
        .report({
          projectId,
          deployment: deploymentRecord({
            id: dispatched.deploymentId,
            kind: DeploymentKind.PREVIEW_UP,
            environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity: "main" },
          }),
        })
        .then(notRefused, refusal);
      expect(report.code).toBe(Code.PermissionDenied);
    } finally {
      await session.cleanup();
    }
  });

  it("names no preview in the token of a job that acts on none", async () => {
    const { session, token } = await dispatchedDeploy();
    try {
      expect(decodeJwt(token).preview).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a job token the console never dispatched", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      const deploymentId = "e".repeat(32);
      const { token } = await signJobToken({
        organizationId: session.organization.id,
        projectId,
        tier: "production",
        jobId: crypto.randomUUID(),
        deploymentId,
        preview: null,
        runnerId: RUNNER,
        slug: "web",
      });

      const error = await serviceClient(DeploymentService, token)
        .start({ projectId, deployment: starting(deploymentId) })
        .then(notRefused, refusal);

      expect(error.code).toBe(Code.PermissionDenied);
      expect(
        await db
          .select()
          .from(deployment)
          .where(
            and(eq(deployment.projectId, projectId), eq(deployment.deploymentId, deploymentId)),
          ),
      ).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });
});

describe("DeploymentService.Start from a session", () => {
  it("records a running deployment that its report then completes", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "web");
      const client = serviceClient(DeploymentService, session.token);
      const record = deploymentRecord();

      await client.start({
        projectId,
        deployment: {
          id: record.id ?? "",
          kind: DeploymentKind.DEPLOY,
          environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
          provider: { name: "aws", region: "us-east-1" },
          target: "aws/123456789012/us-east-1/main",
          startedAt: timestampFromDate(new Date("2025-12-31T23:58:00.000Z")),
          trigger: { kind: TriggerKind.CLI, actor: "victor" },
        },
      });
      const [running] = await db
        .select()
        .from(deployment)
        .where(eq(deployment.projectId, projectId));
      expect(running).toMatchObject({ outcome: null, deployedAt: null, providerName: "aws" });

      await client.report({ projectId, deployment: record });
      await client.report({ projectId, deployment: record });

      const rows = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "succeeded", trigger: { kind: "ci" } });
    } finally {
      await session.cleanup();
    }
  });
});
