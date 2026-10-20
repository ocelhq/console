import { Code, ConnectError } from "@connectrpc/connect";
import { auth } from "@console/auth";
import { JobPhase, JobState } from "@console/connectors/gen/cloud/v1/job_pb";
import { setupTestDatabase } from "@console/db/testing";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudEvent, cloudJob, type FakeCloud, startFakeCloud } from "../../test/cloud-harness";
import type { CloudOffer } from "../routes/connect/cloud";
import { cloudJobsFor, refusalOf } from "./jobs";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("../routes/connect/cloud", () => ({ readCloudOffer: () => offered.cloud }));

const session = { userId: "user-1", activeOrganizationId: "org-1" };

let cloud: FakeCloud;

async function verified(authorization: string) {
  const response = await auth.handler(new Request("http://localhost:3000/api/auth/jwks"));
  const { payload } = await jwtVerify(
    authorization.replace(/^Bearer /, ""),
    createLocalJWKSet(await response.json()),
    { issuer: "http://localhost:3000", audience: "ocel-cloud" },
  );
  return payload;
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
    expect(cloudJobsFor(session)).toBeNull();
  });

  it("reads a job with a one-minute read token for the organization, as IssueCloudToken signs it", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_read" }));

    const answer = await cloudJobsFor(session)?.get("job_read");

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

  it("cancels with a write token", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_cancel" }));

    const answer = await cloudJobsFor(session)?.cancel("job_cancel");

    expect(answer).toMatchObject({ ok: true, result: { state: "canceled" } });
    expect((await verified(cloud.seen[0].authorization)).scope).toEqual(["cloud.apps.write"]);
  });

  it("lists the events after a seq, capped at Ocel Cloud's limit, with the job", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_events", state: JobState.SUCCEEDED }), [
      cloudEvent(1, "checking", JobPhase.CHECK),
      cloudEvent(2, "building"),
      cloudEvent(3, "built"),
    ]);

    const answer = await cloudJobsFor(session)?.events("job_events", 1, 5000);

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

  it("finds no job that belongs to another organization", async () => {
    offer();
    cloud.add("org-2", cloudJob({ id: "job_theirs" }));

    expect(await cloudJobsFor(session)?.get("job_theirs")).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("answers unreachable when nothing listens at the Ocel Cloud URL", async () => {
    offered.cloud = { apiUrl: "http://127.0.0.1:9", providerUrl: "", audience: "ocel-cloud" };

    expect(await cloudJobsFor(session)?.get("job_1")).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });

  it("passes on what Ocel Cloud refused", async () => {
    offer();
    cloud.add("org-1", cloudJob({ id: "job_refused" }));
    cloud.failWith(new ConnectError("bad audience", Code.Unauthenticated));

    expect(await cloudJobsFor(session)?.get("job_refused")).toEqual({
      ok: false,
      reason: "refused",
      message: "Ocel Cloud refused the console's token: bad audience",
    });
  });
});

describe("refusalOf", () => {
  it.each([
    [Code.NotFound, "not-found"],
    [Code.PermissionDenied, "not-found"],
    [Code.FailedPrecondition, "ended"],
    [Code.Unauthenticated, "refused"],
    [Code.Unavailable, "unreachable"],
    [Code.Internal, "unreachable"],
  ])("maps %s to %s", (code, reason) => {
    expect(refusalOf(new ConnectError("no", code))).toMatchObject({ ok: false, reason });
  });

  it("treats anything that is not a Connect error as unreachable", () => {
    expect(refusalOf(new Error("socket hang up"))).toEqual({
      ok: false,
      reason: "unreachable",
      message: "socket hang up",
    });
  });
});
