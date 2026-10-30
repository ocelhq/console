import { Code, ConnectError } from "@connectrpc/connect";
import { auth } from "@console/auth";
import { Role } from "@console/connectors";
import { JobState } from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { deployment, type Job, job, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { and, eq, inArray } from "drizzle-orm";
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobDeps } from "./deps";
import { recordDispatch } from "./dispatch";
import { type FakeRunner, fakeRunner } from "./fake-runner";
import { sendJob } from "./send";
import { sweepJobs, UNREACHABLE_BOUND_MS } from "./sweep";
import { JOB_GRACE_SECONDS, JOB_TIMEOUT_SECONDS } from "./token";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const projectId = crypto.randomUUID();
const RUNNER = "0b7f3c52-5d2a-4a8e-9a43-3c1f1d0e9a11";
const SOURCE = "c".repeat(64);

let runner: FakeRunner;
let notified: Job[];
let clock: Date;
const deps: JobDeps = {
  get runners() {
    return runner;
  },
  notify: async (changed) => {
    notified.push(changed);
  },
  now: () => clock,
};

const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function dispatch(
  kind: Job["kind"] = "deploy",
  over: { tier?: Job["tier"]; pr?: number; preview?: string } = {},
): Promise<Job> {
  const { job: made } = await recordDispatch(db, {
    projectId,
    tier: over.tier ?? (kind === "deploy" ? "production" : "preview"),
    kind,
    requestId: crypto.randomUUID().replaceAll("-", ""),
    runnerId: RUNNER,
    spec: {
      source: { sourceId: SOURCE },
      ...(kind.startsWith("preview")
        ? { preview: { name: over.preview ?? "feature", persistent: false } }
        : {}),
    },
    pr: over.pr ?? 0,
    sha: null,
    branch: null,
    eventAt: clock,
    trigger: { kind: "cli", actor: "user-1" },
  });
  await sendJob(made.id, deps);
  return row(made.id);
}

async function row(id: string): Promise<Job> {
  const [found] = await db.select().from(job).where(eq(job.id, id));
  if (!found) throw new Error(`no job ${id}`);
  return found;
}

async function deploymentOf(made: Job) {
  const [found] = await db
    .select()
    .from(deployment)
    .where(
      and(
        eq(deployment.projectId, projectId),
        eq(deployment.deploymentId, made.deploymentId ?? ""),
      ),
    );
  return found;
}

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  await db
    .insert(project)
    .values({ id: projectId, organizationId: orgId, name: "Web", slug: "web" });
});

beforeEach(async () => {
  await db.delete(job).where(eq(job.projectId, projectId));
  await db.delete(deployment).where(eq(deployment.projectId, projectId));
  runner = fakeRunner();
  notified = [];
  clock = new Date();
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("dispatch", () => {
  it("writes the job and a queued deployment, then starts it on its runner with a job token", async () => {
    const made = await dispatch();

    expect(made).toMatchObject({ status: "queued", runnerId: RUNNER, kind: "deploy" });
    expect(made.acknowledgedAt).not.toBeNull();
    expect(made.deploymentId).toMatch(/^[0-9a-f]{32}$/);
    expect(await deploymentOf(made)).toMatchObject({
      kind: "deploy",
      tier: "production",
      outcome: null,
      jobId: made.id,
      runnerId: RUNNER,
      trigger: { kind: "cli", actor: "user-1" },
    });

    const [started] = runner.started;
    expect(started?.request.source).toEqual({ case: "sourceId", value: SOURCE });
    const jwks = await auth.handler(new Request("http://localhost:3000/api/auth/jwks"));
    const { payload } = await jwtVerify(
      started?.token ?? "",
      createLocalJWKSet((await jwks.json()) as JSONWebKeySet),
      { issuer: "http://localhost:3000", audience: "ocel-job" },
    );
    expect(payload).toMatchObject({
      sub: `org:${orgId}:tier:production:project:${projectId}`,
      job_id: made.id,
      deployment_id: made.deploymentId,
      runner: RUNNER,
      slug: "web",
    });
    expect(payload.preview).toBeUndefined();
  });

  it("records a preview's deployment in the preview's environment from the start", async () => {
    const made = await dispatch("preview-up");

    expect(await deploymentOf(made)).toMatchObject({
      tier: "preview",
      environmentIdentity: "feature",
    });
  });

  it("names no deployment in the token of a job that deploys nothing", async () => {
    const made = await dispatch("preview-rm");

    expect(made.deploymentId).toBeNull();
    const claims = JSON.parse(
      Buffer.from(runner.started[0]?.token.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims.deployment_id).toBeUndefined();
    expect(claims.preview).toBe("feature");
  });

  it("returns the job a request already dispatched, and starts it once", async () => {
    const input = {
      projectId,
      tier: "production" as const,
      kind: "deploy" as const,
      requestId: "same-request",
      runnerId: RUNNER,
      spec: { source: { sourceId: SOURCE } },
      pr: 0,
      sha: null,
      branch: null,
      eventAt: clock,
      trigger: { kind: "cli" as const },
    };
    const first = await recordDispatch(db, input);
    const again = await recordDispatch(db, input);

    expect(again).toEqual({ job: first.job, created: false });
  });
});

describe("the sweep", () => {
  it("follows the runner from running to input required and back", async () => {
    const made = await dispatch();
    runner.set(made.id, JobState.RUNNING);
    await sweepJobs(deps);
    expect((await row(made.id)).status).toBe("running");

    runner.set(made.id, JobState.INPUT_REQUIRED);
    await sweepJobs(deps);
    expect((await row(made.id)).status).toBe("input-required");

    runner.set(made.id, JobState.RUNNING);
    await sweepJobs(deps);
    expect((await row(made.id)).status).toBe("running");
    expect(notified.map((changed) => changed.status)).toEqual([
      "running",
      "input-required",
      "running",
    ]);
  });

  it("never moves a job back from where the runner already took it", async () => {
    const made = await dispatch();
    runner.set(made.id, JobState.RUNNING);
    await sweepJobs(deps);
    runner.set(made.id, JobState.QUEUED);

    await sweepJobs(deps);

    expect((await row(made.id)).status).toBe("running");
  });

  it("fails the deployment with the runner's error when the job ended with no report", async () => {
    const made = await dispatch();
    runner.set(made.id, JobState.FAILED, "the build broke");

    await sweepJobs(deps);

    expect(await row(made.id)).toMatchObject({ status: "failed", error: "the build broke" });
    expect(await deploymentOf(made)).toMatchObject({ outcome: "failed", error: "the build broke" });
  });

  it("records a deployment whose job its runner says succeeded as succeeded, by the console, when ocel never reported it", async () => {
    const made = await dispatch();
    runner.set(made.id, JobState.SUCCEEDED);

    await sweepJobs(deps);

    expect(await deploymentOf(made)).toMatchObject({
      outcome: "succeeded",
      outcomeBy: "console",
      error: null,
      promotionId: null,
    });
  });

  it("leaves the outcome ocel reported", async () => {
    const made = await dispatch();
    await db
      .update(deployment)
      .set({ outcome: "succeeded", outcomeBy: "ocel", deployedAt: clock })
      .where(eq(deployment.deploymentId, made.deploymentId ?? ""));
    runner.set(made.id, JobState.SUCCEEDED);

    await sweepJobs(deps);

    expect((await row(made.id)).status).toBe("done");
    expect(await deploymentOf(made)).toMatchObject({ outcome: "succeeded", error: null });
  });

  it("records a canceled job's deployment as canceled", async () => {
    const made = await dispatch("preview-up");
    runner.set(made.id, JobState.CANCELED);

    await sweepJobs(deps);

    expect(await deploymentOf(made)).toMatchObject({ outcome: "canceled" });
  });

  it("brings a job that deploys nothing to its end", async () => {
    const removal = await dispatch("preview-rm");
    const destroy = await dispatch("projects-destroy", { tier: "production" });
    runner.set(removal.id, JobState.SUCCEEDED);
    runner.set(destroy.id, JobState.FAILED, "a stack is protected");

    await sweepJobs(deps);

    expect((await row(removal.id)).status).toBe("done");
    expect(await row(destroy.id)).toMatchObject({
      status: "failed",
      error: "a stack is protected",
    });
  });

  it("fails a job its runner no longer knows, once the runner has been asked for longer than the bound", async () => {
    const made = await dispatch();
    runner.jobs.delete(made.id);

    await sweepJobs(deps);
    expect(await row(made.id)).toMatchObject({ status: "queued" });
    expect((await row(made.id)).unreachableSince).not.toBeNull();

    later(UNREACHABLE_BOUND_MS + 1000);
    await sweepJobs(deps);

    expect(await row(made.id)).toMatchObject({
      status: "failed",
      error: "The runner no longer knows the job",
    });
    expect(await deploymentOf(made)).toMatchObject({ outcome: "failed" });
  });

  it("forgets a runner's silence once it answers again", async () => {
    const made = await dispatch();
    runner.refuse.get = new ConnectError("connection refused", Code.Unavailable);
    await sweepJobs(deps);
    runner.refuse.get = undefined;
    later(UNREACHABLE_BOUND_MS + 1000);

    await sweepJobs(deps);

    expect(await row(made.id)).toMatchObject({ status: "queued", unreachableSince: null });
  });

  it("sends a job the runner never acknowledged again, with a fresh token for the same job", async () => {
    runner.refuse.start = new ConnectError("connection refused", Code.Unavailable);
    const made = await dispatch();
    expect(made.acknowledgedAt).toBeNull();
    runner.refuse.start = undefined;

    later(60_000);
    await sweepJobs(deps);

    expect(runner.started.map((started) => started.job.jobId)).toEqual([made.id]);
    expect((await row(made.id)).acknowledgedAt).not.toBeNull();
  });

  it("keeps why a runner did not answer as a note, and gives only an ended job an error", async () => {
    runner.refuse.start = new ConnectError("connection refused", Code.Unavailable);
    const made = await dispatch();

    expect(made).toMatchObject({ status: "queued", note: "connection refused", error: null });
  });

  it("cancels at its runner a job canceled before the runner acknowledged it", async () => {
    runner.refuse.start = new ConnectError("connection refused", Code.Unavailable);
    const made = await dispatch();
    await db.update(job).set({ cancelRequested: true }).where(eq(job.id, made.id));
    runner.refuse.start = undefined;

    await sweepJobs(deps);

    expect(runner.started).toEqual([]);
    expect(runner.canceled).toEqual([made.id]);
    expect(await row(made.id)).toMatchObject({ status: "canceled" });
    expect(await deploymentOf(made)).toMatchObject({ outcome: "canceled", outcomeBy: "console" });
  });

  it("cancels a job on its own with the least role the job's command needs", async () => {
    runner.refuse.start = new ConnectError("connection refused", Code.Unavailable);
    const deploying = await dispatch("preview-up");
    const destroying = await dispatch("projects-destroy", { tier: "production" });
    await db
      .update(job)
      .set({ cancelRequested: true })
      .where(inArray(job.id, [deploying.id, destroying.id]));
    runner.refuse.start = undefined;

    await sweepJobs(deps);

    expect(runner.canceledAs).toEqual(
      new Map([
        [deploying.id, Role.MEMBER],
        [destroying.id, Role.ADMIN],
      ]),
    );
  });

  it("fails a job its runner took but never ended, once it outlives the job's time limit", async () => {
    const made = await dispatch();
    runner.set(made.id, JobState.RUNNING);
    await sweepJobs(deps);

    later((JOB_TIMEOUT_SECONDS + JOB_GRACE_SECONDS) * 1000 + 1000);
    await sweepJobs(deps);

    expect(await row(made.id)).toMatchObject({ status: "failed" });
    expect((await row(made.id)).error).toMatch(/time limit/);
    expect(await deploymentOf(made)).toMatchObject({ outcome: "failed" });
  });

  it("measures a job's time limit from when its runner took it, not from its dispatch", async () => {
    runner.refuse.start = new ConnectError("at capacity", Code.ResourceExhausted);
    const made = await dispatch();
    later(60 * 60_000);
    runner.refuse.start = undefined;
    await sweepJobs(deps);
    runner.set(made.id, JobState.RUNNING);

    later((JOB_TIMEOUT_SECONDS + JOB_GRACE_SECONDS) * 1000 - 60_000);
    await sweepJobs(deps);

    expect(await row(made.id)).toMatchObject({ status: "running", error: null });
  });

  it.each([
    Code.InvalidArgument,
    Code.NotFound,
    Code.FailedPrecondition,
    Code.PermissionDenied,
    Code.Unauthenticated,
    Code.Unimplemented,
  ])(
    "fails a job its runner refused outright (code %i) with the runner's reason, and frees its lane",
    async (code) => {
      runner.refuse.start = new ConnectError("the runner cannot run this", code);
      const refused = await dispatch();
      runner.refuse.start = undefined;

      expect(refused).toMatchObject({
        status: "failed",
        error: "The runner refused the job: the runner cannot run this",
      });
      expect(await deploymentOf(refused)).toMatchObject({ outcome: "failed" });
      expect((await dispatch()).acknowledgedAt).not.toBeNull();
    },
  );

  it.each([Code.Unavailable, Code.DeadlineExceeded, Code.Aborted, Code.Internal, Code.Unknown])(
    "keeps sending a job its runner did not answer (code %i)",
    async (code) => {
      runner.refuse.start = new ConnectError("connection reset", code);
      const made = await dispatch();

      expect(made).toMatchObject({ status: "queued", note: "connection reset", error: null });
      expect(made.unreachableSince).not.toBeNull();
    },
  );

  it("keeps sending a job a runner at capacity refused, and fails one no runner took within the bound", async () => {
    runner.refuse.start = new ConnectError("at capacity", Code.ResourceExhausted);
    const full = await dispatch();
    expect(full).toMatchObject({ status: "queued", unreachableSince: null });

    runner.refuse.start = new ConnectError("connection refused", Code.Unavailable);
    const down = await dispatch("preview-up", { pr: 4 });

    later(UNREACHABLE_BOUND_MS + 1000);
    await sweepJobs(deps);

    expect((await row(full.id)).status).toBe("queued");
    expect(await row(down.id)).toMatchObject({ status: "failed" });
    expect((await row(down.id)).error).toMatch(/did not take the job: connection refused/);
  });

  it("runs previews of different names side by side, and holds a second job for the same preview", async () => {
    const first = await dispatch("preview-up", { preview: "alpha" });
    const other = await dispatch("preview-up", { preview: "beta" });
    const again = await dispatch("preview-rm", { preview: "alpha" });

    expect([first.pr, other.pr]).toEqual([0, 0]);
    expect(first.dispatchedAt).not.toBeNull();
    expect(other.dispatchedAt).not.toBeNull();
    expect(again.dispatchedAt).toBeNull();
    expect([first.lane, other.lane, again.lane]).toEqual(["alpha", "beta", "alpha"]);
  });

  it("dispatches the next held job of a tier once the one before it ends", async () => {
    const first = await dispatch();
    const second = await dispatch();
    expect(second.dispatchedAt).toBeNull();

    runner.set(first.id, JobState.SUCCEEDED);
    await sweepJobs(deps);

    expect(runner.started.map((started) => started.job.jobId)).toEqual([first.id, second.id]);
    expect((await row(second.id)).acknowledgedAt).not.toBeNull();
  });
});
