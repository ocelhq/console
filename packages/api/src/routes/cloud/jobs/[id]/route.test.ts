import { JobState } from "@console/connectors/gen/cloud/v1/job_pb";
import { setupTestDatabase } from "@console/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestSessionWithOrganization } from "../../../../../test/auth-harness";
import {
  cloudEvent,
  cloudJob,
  type FakeCloud,
  startFakeCloud,
} from "../../../../../test/cloud-harness";
import type { CloudOffer } from "../../../connect/cloud";
import { cancelCloudJob } from "./cancel/route";
import { listCloudJobEvents } from "./events/route";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("../../../connect/cloud", () => ({ readCloudOffer: () => offered.cloud }));

let cloud: FakeCloud;

type Session = Awaited<ReturnType<typeof createTestSessionWithOrganization>>;

function events(session: Session | null, id: string, after?: string) {
  const query = after === undefined ? "" : `?after=${after}`;
  return listCloudJobEvents(
    new Request(`http://localhost:3000/api/cloud/jobs/${id}/events${query}`, {
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
  });

  function offer() {
    offered.cloud = { apiUrl: cloud.url, providerUrl: "", audience: "ocel-cloud" };
  }

  it("refuse a request without a session", async () => {
    offer();
    expect((await events(null, "job_1")).status).toBe(401);
    expect((await cancel(null, "job_1")).status).toBe(401);
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

  it("answer 409 for a job that has already ended", async () => {
    offer();
    const session = await createTestSessionWithOrganization();
    try {
      cloud.add(
        session.organization.id,
        cloudJob({ id: "job_route_ended", state: JobState.SUCCEEDED }),
      );

      const response = await cancel(session, "job_route_ended");

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "the job has ended", reason: "ended" });
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
});
