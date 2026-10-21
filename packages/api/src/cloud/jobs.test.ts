import { createServer } from "node:http";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { auth } from "@console/auth";
import {
  JobPhase,
  JobSchema,
  JobService,
  JobState,
  RespondJobRequestSchema,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { setupTestDatabase } from "@console/db/testing";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudEvent, cloudJob, type FakeCloud, startFakeCloud } from "../../test/cloud-harness";
import {
  CONSOLE_FAILED,
  cloudJobsFor,
  NOT_ALLOWED,
  refusalOf,
  respondRefusalOf,
  STALE_INPUT,
} from "./jobs";
import type { CloudOffer } from "./offer";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("./offer", () => ({ readCloudOffer: () => offered.cloud }));

const caller = { userId: "user-1", organizationId: "org-1", role: "owner" };

let cloud: FakeCloud;

function giving(
  jobId: string,
  inputId: string,
  values: { key: string; folder: string; value: string }[],
) {
  return create(RespondJobRequestSchema, {
    jobId,
    inputId,
    answer: { case: "variables", value: { values } },
  });
}

function confirming(jobId: string, inputId: string, confirmed: boolean) {
  return create(RespondJobRequestSchema, {
    jobId,
    inputId,
    answer: { case: "confirmed", value: confirmed },
  });
}

async function verified(authorization: string) {
  const response = await auth.handler(new Request("http://localhost:3000/api/auth/jwks"));
  const { payload } = await jwtVerify(
    authorization.replace(/^Bearer /, ""),
    createLocalJWKSet(await response.json()),
    { issuer: "http://localhost:3000", audience: "ocel-cloud" },
  );
  return payload;
}

async function read(jobId: string) {
  const answer = await cloudJobsFor(caller)?.events(jobId, 0);
  return answer?.ok ? { ok: true, result: answer.result.job } : answer;
}

describe("cloudJobsFor", () => {
  beforeAll(async () => {
    await setupTestDatabase();
    cloud = await startFakeCloud();
  });

  afterAll(async () => {
    await cloud.close();
  });

  afterEach(() => {
    offered.cloud = undefined;
    cloud.seen.length = 0;
    cloud.failWith(null);
  });

  function offer() {
    offered.cloud = { apiUrl: cloud.url, providerUrl: "", audience: "ocel-cloud" };
  }

  it("is null when the console offers no Ocel Cloud", () => {
    expect(cloudJobsFor(caller)).toBeNull();
  });

  it("reads a job with a one-minute read token for the organization, as IssueCloudToken signs it", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_read" }));

    const answer = await read("job_read");

    expect(answer).toMatchObject({
      ok: true,
      result: {
        id: "job_read",
        projectId: "project-1",
        command: "deploy",
        state: "running",
        phase: "build",
        step: "Building web",
        createdAt: "2026-10-20T10:00:00.000Z",
        startedAt: "2026-10-20T10:00:02.000Z",
        endedAt: null,
        error: null,
        result: null,
      },
    });
    const payload = await verified(cloud.seen[0].authorization);
    expect(payload).toMatchObject({
      sub: "org:org-1",
      act: "user-1",
      scope: ["cloud.apps.read"],
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
  });

  it("cancels with a read and write token", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_cancel" }));

    const answer = await cloudJobsFor(caller)?.cancel("job_cancel");

    expect(answer).toMatchObject({ ok: true, result: { state: "canceled" } });
    expect((await verified(cloud.seen[0].authorization)).scope).toEqual([
      "cloud.apps.read",
      "cloud.apps.write",
    ]);
  });

  it("waits on a cancel longer than Ocel Cloud waits for the run to stop", async () => {
    const timeouts = new Map<string, number | undefined>();
    const job = create(JobSchema, cloudJob({ id: "job_timed" }));
    const server = createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(JobService, {
            async listJobEvents(_, context) {
              timeouts.set("ListJobEvents", context.timeoutMs());
              return { job, events: [], more: false };
            },
            async cancelJob(_, context) {
              timeouts.set("CancelJob", context.timeoutMs());
              return { job };
            },
          });
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    offered.cloud = { apiUrl: `http://127.0.0.1:${port}`, providerUrl: "", audience: "ocel-cloud" };
    try {
      await cloudJobsFor(caller)?.events("job_timed", 0);
      await cloudJobsFor(caller)?.cancel("job_timed");

      expect(timeouts.get("CancelJob")).toBeGreaterThan(20_000);
      expect(timeouts.get("ListJobEvents")).toBeLessThanOrEqual(10_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("lists the events after a seq, capped at Ocel Cloud's limit, with the job", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_events", state: JobState.SUCCEEDED }), [
      cloudEvent(1, "checking", JobPhase.CHECK),
      cloudEvent(2, "building"),
      cloudEvent(3, "built"),
    ]);

    const answer = await cloudJobsFor(caller)?.events("job_events", 1, 5000);

    expect(cloud.seen[0]).toMatchObject({ afterSeq: 1n, limit: 1000 });
    expect(answer).toEqual({
      ok: true,
      result: {
        job: expect.objectContaining({ id: "job_events", state: "succeeded" }),
        events: [
          {
            seq: 2,
            time: "2026-10-20T10:00:02.000Z",
            level: "info",
            phase: "build",
            message: "building",
          },
          {
            seq: 3,
            time: "2026-10-20T10:00:03.000Z",
            level: "info",
            phase: "build",
            message: "built",
          },
        ],
        more: false,
      },
    });
  });

  function waitingForVariables(id: string) {
    return cloudJob({
      id,
      state: JobState.INPUT_REQUIRED,
      input: {
        id: "input_1",
        need: {
          case: "variables",
          value: {
            tier: Tier.PRODUCTION,
            variables: [
              {
                key: "DATABASE_URL",
                folder: "",
                secret: true,
                description: "The primary database",
                reason: "no value",
                group: "",
              },
              { key: "STRIPE_KEY", folder: "/apps/web", reason: "no value", group: "stripe" },
            ],
            groups: [{ key: "stripe", description: "Payments" }],
          },
        },
      },
    });
  }

  it("reads what a paused job is waiting for", async () => {
    offer();
    cloud.add("org-1", waitingForVariables("job_waiting"));

    const answer = await read("job_waiting");

    expect(answer).toMatchObject({
      ok: true,
      result: {
        state: "input-required",
        input: {
          id: "input_1",
          kind: "variables",
          tier: "production",
          variables: [
            {
              key: "DATABASE_URL",
              folder: "",
              secret: true,
              description: "The primary database",
              reason: "no value",
              group: "",
            },
            {
              key: "STRIPE_KEY",
              folder: "/apps/web",
              secret: false,
              description: "",
              reason: "no value",
              group: "stripe",
            },
          ],
          groups: [{ key: "stripe", description: "Payments" }],
        },
      },
    });
  });

  it("reads a confirmation a paused job is waiting for, and no input on a running job", async () => {
    offer();
    cloud.add(
      "org-1",
      cloudJob({
        id: "job_confirm_read",
        state: JobState.INPUT_REQUIRED,
        input: {
          id: "input_c",
          need: {
            case: "confirmation",
            value: { finding: "3 resources will be replaced", question: "Deploy anyway?" },
          },
        },
      }),
    );
    cloud.add("org-1", cloudJob({ id: "job_no_input" }));

    expect(await read("job_confirm_read")).toMatchObject({
      ok: true,
      result: {
        input: {
          id: "input_c",
          kind: "confirmation",
          finding: "3 resources will be replaced",
          question: "Deploy anyway?",
        },
      },
    });
    expect(await read("job_no_input")).toMatchObject({
      ok: true,
      result: { input: null },
    });
  });

  it("answers the variables a job asked for with a token that writes variables, and the job resumes", async () => {
    offer();
    cloud.add("org-1", waitingForVariables("job_respond"));

    const answer = await cloudJobsFor(caller)?.respond(
      giving("job_respond", "input_1", [
        { key: "DATABASE_URL", folder: "", value: "postgres://secret" },
        { key: "STRIPE_KEY", folder: "/apps/web", value: "sk_live" },
      ]),
    );

    expect(answer).toMatchObject({ ok: true, result: { state: "running", input: null } });
    expect(cloud.seen[0]).toMatchObject({
      method: "RespondJob",
      jobId: "job_respond",
      inputId: "input_1",
      answer: {
        case: "variables",
        value: {
          values: [
            { key: "DATABASE_URL", folder: "", value: "postgres://secret" },
            { key: "STRIPE_KEY", folder: "/apps/web", value: "sk_live" },
          ],
        },
      },
    });
    expect((await verified(cloud.seen[0].authorization)).scope).toEqual([
      "cloud.apps.read",
      "cloud.apps.write",
      "cloud.variables.write",
    ]);
  });

  it("answers a confirmation with a read and write token", async () => {
    offer();
    cloud.add(
      "org-1",
      cloudJob({
        id: "job_confirm",
        state: JobState.INPUT_REQUIRED,
        input: {
          id: "input_c",
          need: { case: "confirmation", value: { question: "Deploy anyway?" } },
        },
      }),
    );

    const answer = await cloudJobsFor(caller)?.respond(confirming("job_confirm", "input_c", false));

    expect(answer).toMatchObject({ ok: true, result: { state: "running" } });
    expect(cloud.seen[0].answer).toEqual({ case: "confirmed", value: false });
    expect((await verified(cloud.seen[0].authorization)).scope).toEqual([
      "cloud.apps.read",
      "cloud.apps.write",
    ]);
  });

  it.each(["member", "admin", "owner"])("lets a %s read, cancel and confirm", async (role) => {
    offer();
    cloud.add("org-1", cloudJob({ id: `job_${role}_cancel` }));
    cloud.add(
      "org-1",
      cloudJob({
        id: `job_${role}_confirm`,
        state: JobState.INPUT_REQUIRED,
        input: { id: "input_c", need: { case: "confirmation", value: { question: "Go?" } } },
      }),
    );
    const jobs = cloudJobsFor({ ...caller, role });

    expect(await jobs?.events(`job_${role}_cancel`, 0)).toMatchObject({ ok: true });
    expect(await jobs?.cancel(`job_${role}_cancel`)).toMatchObject({ ok: true });
    expect(await jobs?.respond(confirming(`job_${role}_confirm`, "input_c", true))).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["admin", true],
    ["owner", true],
    ["member,admin", true],
    ["member", false],
  ])("lets a role of %s answer variables: %s", async (role, allowed) => {
    offer();
    const id = `job_${role.replace(",", "_")}_values`;
    cloud.add("org-1", waitingForVariables(id));

    const answer = await cloudJobsFor({ ...caller, role })?.respond(
      giving(id, "input_1", [{ key: "DATABASE_URL", folder: "", value: "x" }]),
    );

    expect(answer?.ok).toBe(allowed);
  });

  it("refuses a member's variables without asking Ocel Cloud", async () => {
    offer();
    cloud.add("org-1", waitingForVariables("job_member_values"));

    const answer = await cloudJobsFor({ ...caller, role: "member" })?.respond(
      giving("job_member_values", "input_1", [{ key: "DATABASE_URL", folder: "", value: "x" }]),
    );

    expect(answer).toEqual({ ok: false, reason: "forbidden", message: NOT_ALLOWED });
    expect(cloud.seen).toEqual([]);
  });

  it.each([
    ["no role", ""],
    ["a role it does not know", "visitor"],
  ])("refuses a caller with %s before it signs a token", async (_, role) => {
    offer();
    cloud.add("org-1", waitingForVariables("job_no_role"));
    const jobs = cloudJobsFor({ ...caller, role });
    const signing = vi.spyOn(auth.api, "signJWT");
    try {
      for (const answer of [
        await jobs?.events("job_no_role", 0),
        await jobs?.cancel("job_no_role"),
        await jobs?.respond(confirming("job_no_role", "input_1", true)),
      ]) {
        expect(answer).toEqual({ ok: false, reason: "forbidden", message: NOT_ALLOWED });
      }
      expect(signing).not.toHaveBeenCalled();
      expect(cloud.seen).toEqual([]);
    } finally {
      signing.mockRestore();
    }
  });

  it("says an answer to an input that is no longer pending is stale", async () => {
    offer();
    cloud.add("org-1", waitingForVariables("job_stale"));

    const answer = await cloudJobsFor(caller)?.respond(confirming("job_stale", "input_old", true));

    expect(answer).toEqual({ ok: false, reason: "stale", message: STALE_INPUT });
  });

  it("passes on why Ocel Cloud refused an answer", async () => {
    offer();
    cloud.add("org-1", waitingForVariables("job_invalid"));

    const answer = await cloudJobsFor(caller)?.respond(
      giving("job_invalid", "input_1", [{ key: "OTHER", folder: "", value: "x" }]),
    );

    expect(answer).toEqual({
      ok: false,
      reason: "invalid",
      message: "input input_1 asks for no OTHER: give values only for the variables it needs",
    });
  });

  it("finds no job that belongs to another organization", async () => {
    offer();
    cloud.add("org-2", cloudJob({ id: "job_theirs" }));

    expect(await read("job_theirs")).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("answers unreachable when nothing listens at the Ocel Cloud URL", async () => {
    offered.cloud = { apiUrl: "http://127.0.0.1:9", providerUrl: "", audience: "ocel-cloud" };

    expect(await read("job_1")).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });

  it("passes on what Ocel Cloud refused", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_refused" }));
    cloud.failWith(new ConnectError("bad audience", Code.Unauthenticated));

    expect(await read("job_refused")).toEqual({
      ok: false,
      reason: "refused",
      message: "Ocel Cloud refused the console's token: bad audience",
    });
  });
});

describe("refusalOf", () => {
  it.each([
    [Code.NotFound, "not-found"],
    [Code.PermissionDenied, "forbidden"],
    [Code.Unauthenticated, "refused"],
    [Code.Unavailable, "unreachable"],
    [Code.Internal, "unreachable"],
  ])("maps %s to %s", (code, reason) => {
    expect(refusalOf(new ConnectError("no", code))).toMatchObject({ ok: false, reason });
  });

  it("logs a failure inside the console and answers without its words", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error('relation "jwks" does not exist');
    try {
      expect(refusalOf(failure)).toEqual({
        ok: false,
        reason: "internal",
        message: CONSOLE_FAILED,
      });
      expect(errors).toHaveBeenCalledWith(expect.any(String), failure);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("respondRefusalOf", () => {
  it.each([
    [Code.FailedPrecondition, "stale"],
    [Code.InvalidArgument, "invalid"],
    [Code.NotFound, "not-found"],
    [Code.PermissionDenied, "forbidden"],
    [Code.Unauthenticated, "refused"],
    [Code.Unavailable, "unreachable"],
  ])("maps %s to %s", (code, reason) => {
    expect(respondRefusalOf(new ConnectError("no", code))).toMatchObject({ ok: false, reason });
  });

  it("says a stale answer is no longer current, not what Ocel Cloud said", () => {
    expect(
      respondRefusalOf(new ConnectError("input inp_2 is pending", Code.FailedPrecondition)),
    ).toEqual({ ok: false, reason: "stale", message: STALE_INPUT });
  });
});
