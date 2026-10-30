import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { claimOf, Role, USER_SCOPES } from "@console/connectors";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  JobCommand,
  JobState,
  RunnerService,
  VariableValueSchema,
} from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { deployment, endpoint, type Job, job, organization, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import type { Member } from "@console/endpoints";
import { type JobDeps, runnerCalls } from "@console/jobs";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FakeRunner,
  RUNNER_AUDIENCE,
  runnerEvent,
  runnerJob,
  startFakeRunner,
} from "../../test/runner-harness";
import { NOT_ALLOWED, runOfDeployment, runOfJob, STALE_INPUT } from "./run";

let runner: FakeRunner;
const organizationId = `org-${crypto.randomUUID()}`;
const projectId = crypto.randomUUID();
const deps: JobDeps = { runners: runnerCalls, notify: async () => {} };

const as = (role: Role): Member => ({ userId: "user-1", organizationId, role });

let lanes = 0;

async function deployed(over: Partial<typeof job.$inferInsert> = {}) {
  const jobId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const now = new Date();
  await db.insert(job).values({
    id: jobId,
    projectId,
    kind: "deploy",
    tier: "production",
    status: "running",
    lane: `lane-${++lanes}`,
    dedupeKey: jobId,
    eventAt: now,
    runnerId: RUNNER_AUDIENCE,
    spec: { source: { sourceId: "a".repeat(64) } },
    dispatchedAt: now,
    acknowledgedAt: now,
    deploymentId: jobId.replaceAll("-", ""),
    ...over,
  });
  await db.insert(deployment).values({
    id: deploymentId,
    projectId,
    deploymentId: jobId.replaceAll("-", ""),
    kind: "deploy",
    tier: "production",
    trigger: { kind: "cli" },
    jobId,
    runnerId: RUNNER_AUDIENCE,
  });
  return { jobId, deploymentId };
}

async function jobRow(id: string): Promise<Job | undefined> {
  const [found] = await db.select().from(job).where(eq(job.id, id));
  return found;
}

async function runOf(deploymentId: string, role = Role.MEMBER) {
  const found = await runOfDeployment(deploymentId, as(role), deps);
  if (!found) throw new Error(`no run for ${deploymentId}`);
  return found;
}

const tokenOf = (seen: { authorization: string } | undefined) =>
  decodeJwt(seen?.authorization.replace("Bearer ", "") ?? "");

beforeAll(async () => {
  await setupTestDatabase();
  runner = await startFakeRunner();
  await db
    .insert(organization)
    .values({ id: organizationId, name: "A", slug: organizationId, createdAt: new Date() });
  await db.insert(project).values({ id: projectId, organizationId, name: "Web", slug: "web" });
  await db.insert(endpoint).values({
    id: RUNNER_AUDIENCE,
    organizationId,
    name: "box",
    vendor: "vps",
    url: runner.url,
    services: [RunnerService.typeName],
    allowedScopes: USER_SCOPES.map(claimOf),
  });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, organizationId));
  await runner.close();
});

describe("a deployment's run on its runner", () => {
  it("reads the job's events from its runner with a token holding only apps.read", async () => {
    const { jobId, deploymentId } = await deployed();
    runner.add(organizationId, runnerJob({ id: jobId }), [
      runnerEvent(1, "Building web"),
      runnerEvent(2, "Built web"),
    ]);

    const answer = await (await runOf(deploymentId)).run.events(1);

    expect(answer).toMatchObject({
      done: true,
      result: { job: { id: jobId, state: "running" }, events: [{ seq: 2 }], more: false },
    });
    expect(tokenOf(runner.seen.at(-1))).toMatchObject({
      aud: RUNNER_AUDIENCE,
      sub: `org:${organizationId}`,
      role: "member",
      scope: ["apps.read"],
    });
  });

  it("answers a confirmation for a member, and supplies values only for an admin", async () => {
    const { jobId, deploymentId } = await deployed({ status: "input-required" });
    runner.add(
      organizationId,
      runnerJob({
        id: jobId,
        state: JobState.INPUT_REQUIRED,
        input: {
          id: "in_1",
          need: {
            case: "variables",
            value: {
              tier: Tier.PRODUCTION,
              variables: [{ key: "STRIPE_KEY", folder: "/web", secret: true }],
            },
          },
        },
      }),
    );
    const values = [
      create(VariableValueSchema, { key: "STRIPE_KEY", folder: "/web", value: "sk" }),
    ];

    const member = await runOf(deploymentId, Role.MEMBER);
    expect(member.mayGiveValues).toBe(false);
    expect(await member.run.supplyVariables("in_1", values)).toMatchObject({
      done: false,
      refusal: { reason: "denied" },
    });

    const admin = await runOf(deploymentId, Role.ADMIN);
    expect(admin.mayGiveValues).toBe(true);
    expect(await admin.run.supplyVariables("in_1", values)).toMatchObject({
      done: true,
      result: { state: "running" },
    });
    expect(tokenOf(runner.seen.at(-1))).toMatchObject({
      role: "admin",
      scope: ["variables.write"],
    });
  });

  it("says an answer to an input the job no longer waits on is stale", async () => {
    const { jobId, deploymentId } = await deployed();
    runner.add(organizationId, runnerJob({ id: jobId }));

    await expect(
      (await runOf(deploymentId, Role.OWNER)).run.answerConfirmation("in_1", true),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("cancels through the console, which asks the runner as itself with the canceler's role", async () => {
    const { jobId, deploymentId } = await deployed();
    runner.add(organizationId, runnerJob({ id: jobId }));

    const answer = await (await runOf(deploymentId)).run.cancel();

    expect(answer).toMatchObject({ done: true, result: { id: jobId, state: "canceled" } });
    expect(await jobRow(jobId)).toMatchObject({ status: "canceled", cancelRequested: true });
    expect(runner.seen.at(-1)).toMatchObject({ method: "CancelJob", jobId });
    expect(tokenOf(runner.seen.at(-1))).toMatchObject({
      sub: `org:${organizationId}`,
      act: "console",
      role: "member",
    });
  });

  it("names a job the runner does not hold as gone, and a runner that fails as offline", async () => {
    const { deploymentId } = await deployed();
    const { run } = await runOf(deploymentId);
    await expect(run.events(0)).rejects.toMatchObject({ status: 404 });

    runner.failWith(new ConnectError("down for maintenance", Code.Unavailable));
    try {
      expect(await run.events(0)).toMatchObject({
        done: false,
        refusal: { reason: "offline", message: "down for maintenance" },
      });
    } finally {
      runner.failWith(null);
    }
  });
});

describe("a deployment whose job its runner has not taken", () => {
  it("is answered by the console while held, and canceled there without asking the runner", async () => {
    const { jobId, deploymentId } = await deployed({
      status: "queued",
      dispatchedAt: null,
      acknowledgedAt: null,
    });
    const asked = runner.seen.length;
    const { run } = await runOf(deploymentId);

    expect(await run.events(0)).toMatchObject({
      done: true,
      result: {
        job: { id: jobId, state: "queued", step: expect.stringMatching(/^Held at the console/) },
        events: [],
        more: false,
      },
    });
    expect(await run.cancel()).toMatchObject({ done: true, result: { state: "canceled" } });
    expect(runner.seen).toHaveLength(asked);
    const [ended] = await db.select().from(deployment).where(eq(deployment.id, deploymentId));
    expect(ended).toMatchObject({ outcome: "canceled", outcomeBy: "console" });
  });

  it("says why it waits while the runner has not acknowledged it", async () => {
    const { deploymentId } = await deployed({
      status: "queued",
      acknowledgedAt: null,
      note: "connection refused",
    });

    expect(await (await runOf(deploymentId)).run.events(0)).toMatchObject({
      done: true,
      result: {
        job: { state: "queued", step: expect.stringContaining("connection refused") },
      },
    });
  });

  it("refuses an answer, since the job asks nothing yet", async () => {
    const { deploymentId } = await deployed({
      status: "queued",
      dispatchedAt: null,
      acknowledgedAt: null,
    });

    await expect(
      (await runOf(deploymentId)).run.answerConfirmation("in_1", true),
    ).rejects.toMatchObject({ status: 409, message: STALE_INPUT });
  });
});

describe("a destroy job", () => {
  async function destroying(
    over: Partial<typeof job.$inferInsert> = {},
    atRunner: Parameters<typeof runnerJob>[0] = {},
  ) {
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(job).values({
      id,
      projectId,
      kind: "projects-destroy",
      tier: "production",
      status: "running",
      lane: `lane-${++lanes}`,
      dedupeKey: id,
      eventAt: now,
      runnerId: RUNNER_AUDIENCE,
      spec: { source: { sourceId: "a".repeat(64) } },
      dispatchedAt: now,
      acknowledgedAt: now,
      ...over,
    });
    runner.add(
      organizationId,
      runnerJob({ id, command: JobCommand.PROJECTS_DESTROY, ...atRunner }),
    );
    return id;
  }

  async function runAs(id: string, role: Role) {
    const found = await runOfJob(id, as(role), deps);
    if (!found) throw new Error(`no run for ${id}`);
    return found.run;
  }

  it("is canceled by no member, whether its runner holds it or the console does", async () => {
    const atRunner = await destroying();
    const held = await destroying({ status: "queued", dispatchedAt: null, acknowledgedAt: null });
    const asked = runner.seen.length;

    for (const id of [atRunner, held]) {
      expect(await (await runAs(id, Role.MEMBER)).cancel()).toMatchObject({
        done: false,
        refusal: { reason: "denied" },
      });
      expect(await jobRow(id)).toMatchObject({ cancelRequested: false });
    }
    expect(runner.seen).toHaveLength(asked);
  });

  it("takes no answer from a member, and an admin's reaches its runner", async () => {
    const id = await destroying(
      { status: "input-required" },
      {
        state: JobState.INPUT_REQUIRED,
        input: {
          id: "in_1",
          need: { case: "confirmation", value: { finding: "f", question: "Destroy it?" } },
        },
      },
    );
    const asked = runner.seen.length;

    const member = await runOfJob(id, as(Role.MEMBER), deps);
    expect(member?.mayGiveValues).toBe(false);
    expect(await member?.run.answerConfirmation("in_1", true)).toEqual({
      done: false,
      refusal: { reason: "denied", message: NOT_ALLOWED },
    });
    expect(await member?.run.supplyVariables("in_1", [])).toEqual({
      done: false,
      refusal: { reason: "denied", message: NOT_ALLOWED },
    });
    expect(runner.seen).toHaveLength(asked);

    expect(await (await runAs(id, Role.ADMIN)).answerConfirmation("in_1", true)).toMatchObject({
      done: true,
      result: { state: "running" },
    });
    expect(runner.seen.at(-1)).toMatchObject({ method: "AnswerConfirmation", jobId: id });
  });

  it("is canceled at its runner for an owner, with a token holding the owner's role", async () => {
    const id = await destroying();

    expect(await (await runAs(id, Role.OWNER)).cancel()).toMatchObject({
      done: true,
      result: { state: "canceled" },
    });
    expect(runner.seen.at(-1)).toMatchObject({ method: "CancelJob", jobId: id });
    expect(tokenOf(runner.seen.at(-1))).toMatchObject({ role: "owner" });
  });
});

describe("a job that deploys nothing", () => {
  it("is followed by its own id, its pending input answered and its cancel relayed", async () => {
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(job).values({
      id,
      projectId,
      kind: "preview-rm",
      tier: "preview",
      status: "input-required",
      lane: `lane-${++lanes}`,
      dedupeKey: id,
      eventAt: now,
      runnerId: RUNNER_AUDIENCE,
      spec: {
        source: { sourceId: "a".repeat(64) },
        preview: { name: "feature", persistent: false },
      },
      dispatchedAt: now,
      acknowledgedAt: now,
    });
    runner.add(
      organizationId,
      runnerJob({
        id,
        state: JobState.INPUT_REQUIRED,
        input: {
          id: "in_1",
          need: { case: "confirmation", value: { finding: "f", question: "Remove it?" } },
        },
      }),
    );
    const found = await runOfJob(id, as(Role.MEMBER), deps);
    if (!found) throw new Error("no run for the removal");

    expect(await found.run.answerConfirmation("in_1", true)).toMatchObject({ done: true });
    expect(runner.seen.at(-1)).toMatchObject({ method: "AnswerConfirmation", jobId: id });
    expect(await found.run.cancel()).toMatchObject({ done: true, result: { state: "canceled" } });
    expect(
      await runOfJob(id, { userId: "u", organizationId: "another", role: Role.OWNER }, deps),
    ).toBeUndefined();
  });
});

it("finds no run for another organization's member", async () => {
  const { deploymentId } = await deployed();

  expect(
    await runOfDeployment(
      deploymentId,
      { userId: "u", organizationId: "another", role: Role.OWNER },
      deps,
    ),
  ).toBeUndefined();
});
