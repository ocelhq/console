import { create } from "@bufbuild/protobuf";
import { JobCommand, JobState } from "@console/connectors/gen/cloud/v1/job_pb";
import { DeploymentSchema } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { deployment } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestSessionWithOrganization,
  createTestSessionWithRole,
} from "../../test/auth-harness";
import { cloudEvent, cloudJob, type FakeCloud, startFakeCloud } from "../../test/cloud-harness";
import { deploymentRecord, projectIn, TRACE_ID } from "../../test/connect-harness";
import { cloudJobsFor } from "./jobs";
import type { CloudOffer } from "./offer";

const offered = vi.hoisted(() => ({ cloud: undefined as CloudOffer | undefined }));

vi.mock("./offer", () => ({ readCloudOffer: () => offered.cloud }));

const cloudReport = (overrides: { id?: string; error?: string } = {}) =>
  create(
    DeploymentSchema,
    deploymentRecord({
      provider: { name: "ocel" },
      target: "ocel/cloud",
      edge: { kind: "none" },
      ...overrides,
    }),
  );

let cloud: FakeCloud;

async function recorded(projectId: string, deploymentId = TRACE_ID) {
  return db
    .select()
    .from(deployment)
    .where(and(eq(deployment.projectId, projectId), eq(deployment.deploymentId, deploymentId)));
}

function deploymentQueries(): () => string[] {
  const query = vi.spyOn(Pool.prototype, "query");
  return () =>
    query.mock.calls
      .map(([sql]) => (typeof sql === "string" ? sql : (sql as { text: string }).text))
      .filter((text) => text.includes('"deployment"'));
}

describe("a finished Ocel Cloud job's deployment report", () => {
  beforeAll(async () => {
    await setupTestDatabase();
    cloud = await startFakeCloud();
    offered.cloud = { apiUrl: cloud.url, providerUrl: "", audience: "ocel-cloud" };
  });

  afterAll(async () => {
    offered.cloud = undefined;
    await cloud.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function finishedJob(organizationId: string, projectId: string, id: string) {
    cloud.add(
      organizationId,
      cloudJob({
        id,
        projectId,
        command: JobCommand.DEPLOY,
        state: JobState.SUCCEEDED,
        result: { urls: ["https://web.example.com"], deploymentId: TRACE_ID },
        report: cloudReport(),
      }),
    );
  }

  it("is recorded in the job's project when a member views the job, under the id the job page links", async () => {
    const owner = await createTestSessionWithOrganization();
    const member = await createTestSessionWithRole(owner.organization.id, "member");
    try {
      const projectId = await projectIn(
        owner.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      await finishedJob(owner.organization.id, projectId, "job_report_view");
      const jobs = cloudJobsFor({
        userId: member.user.id,
        organizationId: owner.organization.id,
        role: "member",
      });

      const answer = await jobs?.events("job_report_view", 0);

      expect(answer?.ok).toBe(true);
      const rows = await recorded(
        projectId,
        answer?.ok ? answer.result.job.result?.deploymentId : "",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "deploy",
        outcome: "succeeded",
        providerName: "ocel",
        edgeKind: "none",
      });
    } finally {
      await member.cleanup();
      await owner.cleanup();
    }
  });

  it("is recorded once however often the job is viewed", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        session.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      await finishedJob(session.organization.id, projectId, "job_report_twice");
      const jobs = cloudJobsFor({
        userId: session.user.id,
        organizationId: session.organization.id,
        role: "member",
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      await jobs?.events("job_report_twice", 0);
      await jobs?.get("job_report_twice");
      await jobs?.events("job_report_twice", 0);

      expect(await recorded(projectId)).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await session.cleanup();
    }
  });

  it("is read in one query and not written again when a recorded job is viewed again", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        session.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      await finishedJob(session.organization.id, projectId, "job_report_cheap");
      const jobs = cloudJobsFor({
        userId: session.user.id,
        organizationId: session.organization.id,
        role: "member",
      });
      await jobs?.events("job_report_cheap", 0);
      const queries = deploymentQueries();

      const answer = await jobs?.events("job_report_cheap", 0);

      expect(answer?.ok).toBe(true);
      expect(queries()).toEqual([expect.stringMatching(/^select /)]);
    } finally {
      await session.cleanup();
    }
  });

  it("is not looked at on a page of events before the last", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        session.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      cloud.add(
        session.organization.id,
        cloudJob({
          id: "job_report_paged",
          projectId,
          state: JobState.SUCCEEDED,
          report: cloudReport(),
        }),
        [cloudEvent(1, "one"), cloudEvent(2, "two")],
      );
      const jobs = cloudJobsFor({
        userId: session.user.id,
        organizationId: session.organization.id,
        role: "member",
      });
      const queries = deploymentQueries();

      const first = await jobs?.events("job_report_paged", 0, 1);

      expect(first).toMatchObject({ ok: true, result: { more: true } });
      expect(queries()).toEqual([]);

      await jobs?.events("job_report_paged", 1, 1);

      expect(await recorded(projectId)).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("keeps the deployment already recorded when the report differs, and still shows the job", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        session.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      await finishedJob(session.organization.id, projectId, "job_report_first");
      cloud.add(
        session.organization.id,
        cloudJob({
          id: "job_report_differs",
          projectId,
          state: JobState.FAILED,
          report: cloudReport({ error: "a different story" }),
        }),
      );
      const jobs = cloudJobsFor({
        userId: session.user.id,
        organizationId: session.organization.id,
        role: "member",
      });
      vi.spyOn(console, "error").mockImplementation(() => {});

      await jobs?.events("job_report_first", 0);
      const answer = await jobs?.events("job_report_differs", 0);

      expect(answer).toMatchObject({ ok: true, result: { job: { state: "failed" } } });
      const rows = await recorded(projectId);
      expect(rows).toHaveLength(1);
      expect(rows[0].error).toBeNull();
    } finally {
      await session.cleanup();
    }
  });

  it("is not recorded for a project outside the viewer's organization", async () => {
    const owner = await createTestSessionWithOrganization();
    const viewer = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        owner.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      await finishedJob(viewer.organization.id, projectId, "job_report_foreign");
      const jobs = cloudJobsFor({
        userId: viewer.user.id,
        organizationId: viewer.organization.id,
        role: "member",
      });

      const answer = await jobs?.events("job_report_foreign", 0);

      expect(answer?.ok).toBe(true);
      expect(await recorded(projectId)).toHaveLength(0);
    } finally {
      await owner.cleanup();
      await viewer.cleanup();
    }
  });

  it("records nothing for a job with no report or one still running", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        session.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      cloud.add(
        session.organization.id,
        cloudJob({ id: "job_report_none", projectId, state: JobState.SUCCEEDED }),
      );
      cloud.add(
        session.organization.id,
        cloudJob({ id: "job_report_running", projectId, report: cloudReport() }),
      );
      const jobs = cloudJobsFor({
        userId: session.user.id,
        organizationId: session.organization.id,
        role: "member",
      });

      await jobs?.events("job_report_none", 0);
      await jobs?.events("job_report_running", 0);

      expect(await db.select().from(deployment).where(eq(deployment.projectId, projectId))).toEqual(
        [],
      );
    } finally {
      await session.cleanup();
    }
  });

  it("still shows the job when the report is not a valid deployment", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(
        session.organization.id,
        `cloud-report-${crypto.randomUUID()}`,
      );
      cloud.add(
        session.organization.id,
        cloudJob({
          id: "job_report_invalid",
          projectId,
          state: JobState.SUCCEEDED,
          report: cloudReport({ id: "not a trace id" }),
        }),
      );
      const jobs = cloudJobsFor({
        userId: session.user.id,
        organizationId: session.organization.id,
        role: "member",
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const answer = await jobs?.events("job_report_invalid", 0);

      expect(answer?.ok).toBe(true);
      expect(errors).toHaveBeenCalled();
      expect(await db.select().from(deployment).where(eq(deployment.projectId, projectId))).toEqual(
        [],
      );
    } finally {
      await session.cleanup();
    }
  });
});
