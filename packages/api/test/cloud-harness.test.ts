import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  JobCommand,
  JobEventLevel,
  JobPhase,
  JobService,
  JobState,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { type JWTPayload, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudEvent, cloudJob, type FakeCloud, startFakeCloud } from "./cloud-harness";

let cloud: FakeCloud;

// The fake reads a token's claims and never its signature, so any key signs one.
function token(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "http://localhost:3000",
    aud: "ocel-cloud",
    sub: "org:org-1",
    act: "user-1",
    scope: ["cloud.apps.read", "cloud.apps.write"],
    iat: now,
    exp: now + 60,
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode("any key"));
}

function client(authorization: string | null) {
  return createClient(
    JobService,
    createConnectTransport({
      baseUrl: cloud.url,
      httpVersion: "1.1",
      interceptors: [
        (next) => (request) => {
          if (authorization !== null) {
            request.header.set("Authorization", authorization);
          }
          return next(request);
        },
      ],
    }),
  );
}

async function as(claims: JWTPayload = {}) {
  return client(`Bearer ${await token(claims)}`);
}

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (thrown) {
    return ConnectError.from(thrown);
  }
  throw new Error("the call was answered");
}

function waiting(id: string) {
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
            { key: "DATABASE_URL", folder: "" },
            { key: "STRIPE_KEY", folder: "/apps/web" },
            { key: "HIDDEN", folder: "/." },
          ],
        },
      },
    },
  });
}

function asking(id: string) {
  return cloudJob({
    id,
    state: JobState.INPUT_REQUIRED,
    input: { id: "input_c", need: { case: "confirmation", value: { question: "Deploy anyway?" } } },
  });
}

describe("the fake Ocel Cloud answers as Ocel Cloud does", () => {
  beforeAll(async () => {
    cloud = await startFakeCloud();
  });

  afterAll(async () => {
    await cloud.close();
  });

  describe("who a call speaks for, as Server.authenticate and trust.Verifier.Verify decide", () => {
    it("refuses a call with no bearer token as unauthenticated", async () => {
      cloud.add("org-1", cloudJob({ id: "job_auth" }));

      expect((await refusal(client(null).getJob({ jobId: "job_auth" }))).code).toBe(
        Code.Unauthenticated,
      );
      expect((await refusal(client("Bearer not-a-jwt").getJob({ jobId: "job_auth" }))).code).toBe(
        Code.Unauthenticated,
      );
    });

    it.each([
      ["signed for another audience", { aud: "another-cloud" }],
      ["issued by a console it does not trust", { iss: "https://elsewhere.example" }],
      ["speaking for a user, not an organization", { sub: "user:user-1" }],
      ["speaking for no organization", { sub: "org:" }],
      ["expired", { exp: Math.floor(Date.now() / 1000) - 120 }],
      ["with no scope", { scope: undefined }],
      ["with a scope that is not a list", { scope: "cloud.apps.read" }],
    ])("refuses a token %s as unauthenticated", async (_, claims) => {
      cloud.add("org-1", cloudJob({ id: "job_auth" }));

      const refused = await refusal((await as(claims)).getJob({ jobId: "job_auth" }));

      expect(refused.code).toBe(Code.Unauthenticated);
    });

    it("refuses a call the token holds no scope for as permission denied, whatever else it holds", async () => {
      cloud.add("org-1", cloudJob({ id: "job_scope" }));
      const reader = await as({ scope: ["cloud.apps.read"] });
      const writer = await as({ scope: ["cloud.apps.write"] });

      expect((await refusal(reader.cancelJob({ jobId: "job_scope" }))).code).toBe(
        Code.PermissionDenied,
      );
      expect(
        (
          await refusal(
            reader.respondJob({
              jobId: "job_scope",
              inputId: "input_1",
              answer: { case: "confirmed", value: true },
            }),
          )
        ).code,
      ).toBe(Code.PermissionDenied);
      expect((await refusal(writer.getJob({ jobId: "job_scope" }))).code).toBe(
        Code.PermissionDenied,
      );
      expect((await refusal(writer.listJobEvents({ jobId: "job_scope" }))).code).toBe(
        Code.PermissionDenied,
      );
    });

    it("refuses an invalid request as invalid before it reads the token, as the validate interceptor runs first", async () => {
      expect((await refusal(client(null).getJob({ jobId: "job.1" }))).code).toBe(
        Code.InvalidArgument,
      );
      expect(
        (await refusal((await as()).listJobEvents({ jobId: "job_1", limit: 1001 }))).code,
      ).toBe(Code.InvalidArgument);
    });
  });

  describe("which job a call reaches, as jobs.read finds it", () => {
    it("finds no job of another organization, nor one never started", async () => {
      cloud.add("org-2", cloudJob({ id: "job_theirs" }));
      const mine = await as();

      for (const jobId of ["job_theirs", "job_never"]) {
        const refused = await refusal(mine.getJob({ jobId }));
        expect(refused.code).toBe(Code.NotFound);
        expect(refused.rawMessage).toBe(`your organization has no job ${jobId}`);
        expect((await refusal(mine.cancelJob({ jobId }))).code).toBe(Code.NotFound);
        expect((await refusal(mine.listJobEvents({ jobId }))).code).toBe(Code.NotFound);
      }
    });

    it("keeps each organization's jobs apart under the same id", async () => {
      cloud.add("org-1", cloudJob({ id: "job_shared", step: "mine" }));
      cloud.add("org-2", cloudJob({ id: "job_shared", step: "theirs" }));

      const { job } = await (await as()).getJob({ jobId: "job_shared" });

      expect(job?.step).toBe("mine");
    });
  });

  describe("StartJob, as jobService.StartJob does with no builder", () => {
    it("refuses to start a job as a failed precondition", async () => {
      const refused = await refusal(
        (await as()).startJob({
          projectId: "project-1",
          slug: "web",
          command: JobCommand.DEPLOY,
          sourceId: "a".repeat(64),
        }),
      );

      expect(refused.code).toBe(Code.FailedPrecondition);
    });
  });

  describe("CancelJob, as jobService.CancelJob does", () => {
    it("answers a job that has ended as it ended, without refusing", async () => {
      cloud.add("org-1", cloudJob({ id: "job_done", state: JobState.SUCCEEDED, step: "Deployed" }));

      const { job } = await (await as()).cancelJob({ jobId: "job_done" });

      expect(job).toMatchObject({ id: "job_done", state: JobState.SUCCEEDED, step: "Deployed" });
    });

    it("ends a running job canceled, with no input and the line its run's end writes", async () => {
      cloud.add("org-1", waiting("job_stop"));
      const caller = await as();

      const { job } = await caller.cancelJob({ jobId: "job_stop" });

      expect(job).toMatchObject({ state: JobState.CANCELED, step: "Canceled" });
      expect(job?.input).toBeUndefined();
      expect(job?.endedAt).toBeDefined();
      const { events } = await caller.listJobEvents({ jobId: "job_stop" });
      expect(events.at(-1)).toMatchObject({
        seq: 1n,
        level: JobEventLevel.WARN,
        phase: JobPhase.BUILD,
        message: "The job was canceled",
      });
    });
  });

  describe("ListJobEvents, as jobService.ListJobEvents pages them", () => {
    it("answers defaultEventsLimit events when no limit is given, and says there are more", async () => {
      cloud.add(
        "org-1",
        cloudJob({ id: "job_long" }),
        Array.from({ length: 250 }, (_, i) => cloudEvent(i + 1, `line ${i + 1}`)),
      );
      const caller = await as();

      const first = await caller.listJobEvents({ jobId: "job_long" });
      const rest = await caller.listJobEvents({ jobId: "job_long", afterSeq: 200n });
      const past = await caller.listJobEvents({ jobId: "job_long", afterSeq: 250n });

      expect(first.events).toHaveLength(200);
      expect(first.more).toBe(true);
      expect(first.job?.id).toBe("job_long");
      expect(rest.events.map((event) => event.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => BigInt(201 + i)),
      );
      expect(rest.more).toBe(false);
      expect(past).toMatchObject({ events: [], more: false });
    });

    it("answers at most the limit asked for", async () => {
      cloud.add("org-1", cloudJob({ id: "job_paged" }), [
        cloudEvent(1, "one"),
        cloudEvent(2, "two"),
        cloudEvent(3, "three"),
      ]);

      const page = await (await as()).listJobEvents({ jobId: "job_paged", afterSeq: 1n, limit: 1 });

      expect(page.events.map((event) => event.message)).toEqual(["two"]);
      expect(page.more).toBe(true);
    });
  });

  describe("RespondJob, as jobService.RespondJob and answerFor check an answer", () => {
    const values = (...names: [string, string][]) => ({
      case: "variables" as const,
      value: { values: names.map(([folder, key]) => ({ folder, key, value: "v" })) },
    });

    it("refuses an answer to a job that waits on no input as a failed precondition", async () => {
      cloud.add("org-1", cloudJob({ id: "job_busy" }));
      cloud.add("org-1", cloudJob({ id: "job_over", state: JobState.SUCCEEDED }));
      const caller = await as();

      for (const [jobId, state] of [
        ["job_busy", "running"],
        ["job_over", "succeeded"],
      ]) {
        const refused = await refusal(
          caller.respondJob({
            jobId,
            inputId: "input_1",
            answer: { case: "confirmed", value: true },
          }),
        );
        expect(refused.code).toBe(Code.FailedPrecondition);
        expect(refused.rawMessage).toBe(`job ${jobId} waits on no input: it is ${state}`);
      }
    });

    it("refuses an answer to an input the job no longer waits on as a failed precondition", async () => {
      cloud.add("org-1", waiting("job_moved"));

      const refused = await refusal(
        (await as()).respondJob({
          jobId: "job_moved",
          inputId: "input_0",
          answer: values(["", "DATABASE_URL"]),
        }),
      );

      expect(refused.code).toBe(Code.FailedPrecondition);
    });

    it.each([
      [
        "a confirmation to an input that asks for values",
        "job_kind_values",
        { case: "confirmed" as const, value: true },
        "input input_1 asks for values, not a confirmation",
      ],
      [
        "values to an input that asks a question",
        "job_kind_question",
        values(["", "DATABASE_URL"]),
        "input input_c asks a question, not for values",
      ],
      [
        "a variable given twice",
        "job_twice",
        values(["", "DATABASE_URL"], ["", "DATABASE_URL"]),
        "DATABASE_URL is given twice",
      ],
      [
        "values the input does not ask for",
        "job_extra",
        values(["", "OTHER"], ["/apps", "MORE"]),
        "input input_1 asks for no OTHER, /apps/MORE: give values only for the variables it needs",
      ],
    ])("refuses %s as invalid, in Ocel Cloud's words", async (_, jobId, answer, message) => {
      cloud.add("org-1", jobId === "job_kind_question" ? asking(jobId) : waiting(jobId));
      const inputId = jobId === "job_kind_question" ? "input_c" : "input_1";

      const refused = await refusal((await as()).respondJob({ jobId, inputId, answer }));

      expect(refused.code).toBe(Code.InvalidArgument);
      expect(refused.rawMessage).toBe(message);
    });

    it("refuses a value the variable store cannot keep as invalid", async () => {
      cloud.add("org-1", waiting("job_unstorable"));

      const refused = await refusal(
        (await as()).respondJob({
          jobId: "job_unstorable",
          inputId: "input_1",
          answer: values(["/.", "HIDDEN"]),
        }),
      );

      expect(refused.code).toBe(Code.InvalidArgument);
      expect(refused.rawMessage).toMatch(/^\/\.\/HIDDEN can't be stored: /);
    });

    it("resumes the job with the answer, logging the keys given and never a value", async () => {
      cloud.add("org-1", waiting("job_answered"));
      const caller = await as();

      const { job } = await caller.respondJob({
        jobId: "job_answered",
        inputId: "input_1",
        answer: values(["", "DATABASE_URL"], ["/apps/web", "STRIPE_KEY"]),
      });
      const again = await refusal(
        caller.respondJob({
          jobId: "job_answered",
          inputId: "input_1",
          answer: values(["", "DATABASE_URL"]),
        }),
      );

      expect(job).toMatchObject({ state: JobState.RUNNING, step: "Resuming with the answer" });
      expect(job?.input).toBeUndefined();
      expect((await caller.listJobEvents({ jobId: "job_answered" })).events).toMatchObject([
        {
          seq: 1n,
          level: JobEventLevel.INFO,
          message: "Values given for DATABASE_URL, /apps/web/STRIPE_KEY",
        },
      ]);
      expect(again.code).toBe(Code.FailedPrecondition);
    });

    it("resumes the job with the answer to its question", async () => {
      cloud.add("org-1", asking("job_said_no"));
      const caller = await as();

      const { job } = await caller.respondJob({
        jobId: "job_said_no",
        inputId: "input_c",
        answer: { case: "confirmed", value: false },
      });

      expect(job).toMatchObject({ state: JobState.RUNNING, step: "Resuming with the answer" });
      expect((await caller.listJobEvents({ jobId: "job_said_no" })).events).toMatchObject([
        { message: "Answered no: Deploy anyway?" },
      ]);
    });
  });
});
