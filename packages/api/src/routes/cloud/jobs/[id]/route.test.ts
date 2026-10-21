import { auth } from "@console/auth";
import { JobState } from "@console/connectors/gen/cloud/v1/job_pb";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { setupTestDatabase } from "@console/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../../../../test/auth-harness";
import {
  cloudEvent,
  cloudJob,
  type FakeCloud,
  startFakeCloud,
} from "../../../../../test/cloud-harness";
import type { CloudOffer } from "../../../connect/cloud";
import { cancelCloudJob } from "./cancel/route";
import { listCloudJobEvents } from "./events/route";
import { RESPOND_BODY_LIMIT, respondCloudJob } from "./respond/route";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("../../../connect/cloud", () => ({ readCloudOffer: () => offered.cloud }));

let cloud: FakeCloud;

type Session = { headers: Headers };

function events(session: Session | null, id: string, after?: string, org?: string) {
  const query = new URLSearchParams();
  if (after !== undefined) query.set("after", after);
  if (org !== undefined) query.set("org", org);
  const search = query.size === 0 ? "" : `?${query}`;
  return listCloudJobEvents(
    new Request(`http://localhost:3000/api/cloud/jobs/${id}/events${search}`, {
      headers: session ? session.headers : {},
    }),
    id,
  );
}

function cancel(session: Session | null, id: string) {
  return cancelCloudJob(
    new Request(`http://localhost:3000/api/cloud/jobs/${id}/cancel`, {
      method: "POST",
      headers: session ? session.headers : {},
    }),
    id,
  );
}

function respond(session: Session | null, id: string, body: unknown) {
  const headers = new Headers(session ? session.headers : {});
  headers.set("content-type", "application/json");
  return respondCloudJob(
    new Request(`http://localhost:3000/api/cloud/jobs/${id}/respond`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    id,
  );
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
          variables: [{ key: "DATABASE_URL", folder: "", secret: true, reason: "no value" }],
        },
      },
    },
  });
}

const secretValue = "postgres://user:hunter2@db.internal/shop";

const answer = {
  inputId: "input_1",
  answer: { kind: "variables", values: [{ key: "DATABASE_URL", folder: "", value: secretValue }] },
};

describe("the Ocel Cloud job routes", () => {
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
    vi.restoreAllMocks();
  });

  function offer() {
    offered.cloud = { apiUrl: cloud.url, providerUrl: "", audience: "ocel-cloud" };
  }

  it("refuse a request without a session", async () => {
    offer();
    expect((await events(null, "job_1")).status).toBe(401);
    expect((await cancel(null, "job_1")).status).toBe(401);
    expect((await respond(null, "job_1", answer)).status).toBe(401);
    expect(cloud.seen).toEqual([]);
  });

  it("are not found when the console offers no Ocel Cloud", async () => {
    offered.cloud = undefined;
    const session = await createTestSessionWithOrganization();
    try {
      expect((await events(session, "job_1")).status).toBe(404);
      expect((await cancel(session, "job_1")).status).toBe(404);
    } finally {
      await session.cleanup();
    }
  });

  it("are not found for an id Ocel Cloud could not have made", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      expect((await events(session, "job.1")).status).toBe(404);
      expect(cloud.seen).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("reach the job of the organization the URL names, not the active one", async () => {
    offer();
    const named = await createTestSessionWithOrganization();
    const active = await createTestSessionWithOrganization();
    const joined = await createTestSessionWithRole(active.organization.id, "member");
    try {
      await auth.api.addMember({
        body: { userId: joined.user.id, organizationId: named.organization.id, role: "member" },
      });
      cloud.add(named.organization.id, cloudJob({ id: "job_route_named" }));

      expect((await events(joined, "job_route_named")).status).toBe(404);
      const response = await events(joined, "job_route_named", undefined, named.organization.id);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ job: { id: "job_route_named" } });
    } finally {
      await joined.cleanup();
      await named.cleanup();
      await active.cleanup();
    }
  });

  it("are not found for an organization the caller does not belong to, even with the job in the active one", async () => {
    offer();
    const mine = await createTestSessionWithOrganization();
    const theirs = await createTestSessionWithOrganization();
    try {
      cloud.add(mine.organization.id, cloudJob({ id: "job_route_mine" }));

      const response = await events(mine, "job_route_mine", undefined, theirs.organization.id);

      expect(response.status).toBe(404);
      expect(cloud.seen).toEqual([]);
    } finally {
      await mine.cleanup();
      await theirs.cleanup();
    }
  });

  it("list the events after the given seq, with the job", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, cloudJob({ id: "job_route_events" }), [
        cloudEvent(1, "one"),
        cloudEvent(2, "two"),
        cloudEvent(3, "three"),
      ]);

      const response = await events(session, "job_route_events", "2");

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.events.map((event: { message: string }) => event.message)).toEqual(["three"]);
      expect(body.job).toMatchObject({ id: "job_route_events", state: "running" });
      expect(body.more).toBe(false);
      expect(cloud.seen[0]).toMatchObject({ method: "ListJobEvents", afterSeq: 2n });
    } finally {
      await session.cleanup();
    }
  });

  it("start from the first event when no seq is given", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, cloudJob({ id: "job_route_first" }), [
        cloudEvent(1, "one"),
      ]);
      const body = await (await events(session, "job_route_first")).json();
      expect(body.events).toHaveLength(1);
      expect(cloud.seen[0]).toMatchObject({ afterSeq: 0n });
    } finally {
      await session.cleanup();
    }
  });

  it("refuse an after that is not a whole number", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      for (const after of ["-1", "1.5", "x", "99999999999999999999"]) {
        expect((await events(session, "job_1", after)).status).toBe(400);
      }
      expect(cloud.seen).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("find no job of another organization, asking with the viewer's own organization", async () => {
    offer();
    const owner = await createTestSessionWithOrganization();
    const stranger = await createTestSessionWithOrganization();
    try {
      cloud.add(owner.organization.id, cloudJob({ id: "job_route_owned" }));

      expect((await events(stranger, "job_route_owned")).status).toBe(404);
      expect((await cancel(stranger, "job_route_owned")).status).toBe(404);
      expect((await events(owner, "job_route_owned")).status).toBe(200);
    } finally {
      await owner.cleanup();
      await stranger.cleanup();
    }
  });

  it("cancel a running job and answer it", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, cloudJob({ id: "job_route_cancel" }));

      const response = await cancel(session, "job_route_cancel");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "canceled" });
    } finally {
      await session.cleanup();
    }
  });

  it("answer a job that has already ended as it ended, without canceling it", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(
        session.organization.id,
        cloudJob({ id: "job_route_ended", state: JobState.SUCCEEDED }),
      );

      const response = await cancel(session, "job_route_ended");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "job_route_ended", state: "succeeded" });
    } finally {
      await session.cleanup();
    }
  });

  it("answer 502 when Ocel Cloud cannot be reached", async () => {
    offered.cloud = { apiUrl: "http://127.0.0.1:9", providerUrl: "", audience: "ocel-cloud" };
    const session = await createTestSessionWithOrganization();
    try {
      const response = await events(session, "job_1");
      expect(response.status).toBe(502);
      expect((await response.json()).reason).toBe("unreachable");
    } finally {
      await session.cleanup();
    }
  });

  it("answer the variables a job asked for, and the job resumes", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, waiting("job_route_respond"));

      const response = await respond(session, "job_route_respond", answer);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ id: "job_route_respond", state: "running", input: null });
      expect(JSON.stringify(body)).not.toContain(secretValue);
      expect(cloud.seen[0]).toMatchObject({ method: "RespondJob", inputId: "input_1" });
    } finally {
      await session.cleanup();
    }
  });

  it("never log the values they pass on", async () => {
    offer();
    const said = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, waiting("job_route_quiet"));
      await respond(session, "job_route_quiet", answer);
      await respond(session, "job_route_quiet", answer);
      await respond(session, "job_route_quiet", { ...answer, inputId: "bad id" });

      for (const spy of said) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain("hunter2");
      }
    } finally {
      await session.cleanup();
    }
  });

  it("answer a confirmation", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(
        session.organization.id,
        cloudJob({
          id: "job_route_confirm",
          state: JobState.INPUT_REQUIRED,
          input: { id: "input_c", need: { case: "confirmation", value: { question: "Go?" } } },
        }),
      );

      const response = await respond(session, "job_route_confirm", {
        inputId: "input_c",
        answer: { kind: "confirmation", confirmed: true },
      });

      expect(response.status).toBe(200);
      expect(cloud.seen[0].answer).toEqual({ case: "confirmed", value: true });
    } finally {
      await session.cleanup();
    }
  });

  it("refuse an answer that is not one, without asking Ocel Cloud or echoing it", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    const value = (key: string, extra = {}) => ({ key, folder: "", value: secretValue, ...extra });
    try {
      for (const body of [
        "not json",
        {},
        { inputId: "input_1" },
        { inputId: "bad id", answer: answer.answer },
        { inputId: "input_1", answer: { kind: "variables", values: [] } },
        { inputId: "input_1", answer: { kind: "variables", values: [value("")] } },
        { inputId: "input_1", answer: { kind: "variables", values: [value("A#B")] } },
        {
          inputId: "input_1",
          answer: { kind: "variables", values: [value("A", { folder: "x" })] },
        },
        { inputId: "input_1", answer: { kind: "variables", values: [value("A", { value: "" })] } },
        { inputId: "input_1", answer: { kind: "variables", values: [value("A"), value("A")] } },
        { inputId: "input_1", answer: { kind: "confirmation", confirmed: "yes" } },
        { inputId: "input_1", answer: { kind: "other" } },
        { ...answer, extra: true },
      ]) {
        const response = await respond(session, "job_1", body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.text()).not.toContain("hunter2");
      }
      expect(cloud.seen).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("refuse an answer larger than the limit", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      const response = await respond(session, "job_1", {
        ...answer,
        answer: {
          kind: "variables",
          values: [{ key: "BIG", folder: "", value: "x".repeat(RESPOND_BODY_LIMIT) }],
        },
      });
      expect(response.status).toBe(413);
      expect(cloud.seen).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("answer 409 for an input that is no longer current", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, waiting("job_route_stale"));

      const response = await respond(session, "job_route_stale", { ...answer, inputId: "input_0" });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "stale" });
    } finally {
      await session.cleanup();
    }
  });

  it("answer 400 with Ocel Cloud's words for an answer it refused", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(session.organization.id, waiting("job_route_invalid"));

      const response = await respond(session, "job_route_invalid", {
        inputId: "input_1",
        answer: { kind: "variables", values: [{ key: "OTHER", folder: "", value: "x" }] },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "input input_1 asks for no OTHER: give values only for the variables it needs",
        reason: "invalid",
      });
    } finally {
      await session.cleanup();
    }
  });

  it("find no job of another organization to answer", async () => {
    offer();
    const owner = await createTestSessionWithOrganization();
    const stranger = await createTestSessionWithOrganization();
    try {
      cloud.add(owner.organization.id, waiting("job_route_answer_owned"));
      expect((await respond(stranger, "job_route_answer_owned", answer)).status).toBe(404);
    } finally {
      await owner.cleanup();
      await stranger.cleanup();
    }
  });
});
