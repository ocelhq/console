import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  DeploymentOutcome,
  EnvironmentEventKind,
  EnvironmentEventSchema,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { Status_StatusCode } from "@console/connectors/gen/opentelemetry/proto/trace/v1/trace_pb";
import { db } from "@console/db";
import { deployment, environmentEvent } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "../../../test/auth-harness";
import {
  connectClient as clientFor,
  projectIn,
  deploymentRecord as record,
  TRACE_ID,
} from "../../../test/connect-harness";

describe("DeploymentService over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("Report stores the deployment in the session's project", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "report-stores");

      await clientFor(session.token).report({ deployment: record("report-stores") });

      const [row] = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
      expect(row).toMatchObject({
        runId: TRACE_ID,
        kind: "deploy",
        outcome: "succeeded",
        environmentClass: "production",
        environmentIdentity: "",
        promotionId: "prm-1",
        tag: "v1",
        providerName: "aws",
        providerRegion: "us-east-1",
        target: "aws/123456789012/us-east-1/main",
        edgeKind: "cloudfront",
        cliVersion: "0.0.2",
        trigger: { kind: "ci", actor: "victor", ci: { provider: "github" } },
        git: { sha: "0123456789abcdef", branch: "main", dirty: false },
      });
      expect(row?.deployedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(row?.topology.apps[0]).toMatchObject({
        name: "web",
        framework: "nextjs",
        compute: "serverless",
        buildId: "build-1",
        deploymentId: "rel-1",
        outcome: "succeeded",
        variables: [
          { key: "DATABASE_URL", class: "secret", folder: "/web" },
          { key: "DATABASE_URL", class: "secret", folder: "/api" },
        ],
      });
      expect(row?.topology.resources[0]?.binding.grants).toEqual([
        { verb: "read", actions: ["select"] },
      ]);
      expect(row?.topology.usages).toEqual([
        { app: "web", resource: "main", files: ["app/page.tsx"] },
      ]);
    } finally {
      await session.cleanup();
    }
  });

  it("Report answers a repeated run once", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "report-twice");
      const client = clientFor(session.token);

      await client.report({ deployment: record("report-twice") });
      await client.report({ deployment: record("report-twice") });

      const rows = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
      expect(rows).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  it("Report refuses a project the session's organization does not own", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const error = await clientFor(session.token)
        .report({ deployment: record("no-such-project") })
        .catch((e: unknown) => e);
      expect(ConnectError.from(error).code).toBe(Code.NotFound);
    } finally {
      await session.cleanup();
    }
  });

  it("refuses a call with no session as Unauthenticated", async () => {
    const error = await clientFor(null)
      .report({ deployment: record("anon") })
      .catch((e: unknown) => e);
    expect(ConnectError.from(error).code).toBe(Code.Unauthenticated);
  });

  it("refuses a bearer that is not a session as Unauthenticated", async () => {
    const error = await clientFor("not-a-session")
      .report({ deployment: record("anon") })
      .catch((e: unknown) => e);
    expect(ConnectError.from(error).code).toBe(Code.Unauthenticated);
  });

  it("Report refuses a succeeded deployment that names no promotion as InvalidArgument", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      await projectIn(session.organization.id, "no-promotion");

      const error = await clientFor(session.token)
        .report({ deployment: record("no-promotion", { promotion: undefined }) })
        .catch((e: unknown) => e);

      const refused = ConnectError.from(error);
      expect(refused.code).toBe(Code.InvalidArgument);
      expect(refused.rawMessage).toContain("a succeeded deployment names the promotion");
    } finally {
      await session.cleanup();
    }
  });

  it("Report refuses a failed deployment that names a promotion as InvalidArgument", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      await projectIn(session.organization.id, "failed-promotion");

      const error = await clientFor(session.token)
        .report({ deployment: record("failed-promotion", { outcome: DeploymentOutcome.FAILED }) })
        .catch((e: unknown) => e);

      const refused = ConnectError.from(error);
      expect(refused.code).toBe(Code.InvalidArgument);
      expect(refused.rawMessage).toContain("deployment.no_promotion_on_failure");
    } finally {
      await session.cleanup();
    }
  });

  it("Report stores the spans as the run's trace", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "report-spans");

      await clientFor(session.token).report({
        deployment: record("report-spans", {
          spans: [
            {
              name: "build",
              startTimeUnixNano: 1_767_225_480_000_000_000n,
              endTimeUnixNano: 1_767_225_540_000_000_000n,
              status: { code: Status_StatusCode.ERROR, message: "next build failed" },
            },
          ],
        }),
      });

      const [row] = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
      expect(row?.trace).toEqual([
        {
          name: "build",
          startedAt: "2025-12-31T23:58:00.000Z",
          finishedAt: "2025-12-31T23:59:00.000Z",
          status: "failed",
          error: "next build failed",
          log: [],
        },
      ]);
    } finally {
      await session.cleanup();
    }
  });

  it("RecordEnvironmentEvent stores a removed preview", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "event-stores");

      await clientFor(session.token).recordEnvironmentEvent({
        event: create(EnvironmentEventSchema, {
          kind: EnvironmentEventKind.PREVIEW_REMOVED,
          slug: "event-stores",
          environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity: "pr-12" },
          at: timestampFromDate(new Date("2026-01-02T00:00:00.000Z")),
          source: { branch: "feat/x" },
          ci: { name: "github", repo: "ocelhq/app" },
        }),
      });

      const [row] = await db
        .select()
        .from(environmentEvent)
        .where(eq(environmentEvent.projectId, projectId));
      expect(row).toMatchObject({
        kind: "preview-removed",
        environmentClass: "preview",
        environmentIdentity: "pr-12",
        git: { sha: "", branch: "feat/x", dirty: false },
        ci: { provider: "github", repo: "ocelhq/app" },
      });
      expect(row?.occurredAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    } finally {
      await session.cleanup();
    }
  });

  it("RecordEnvironmentEvent refuses a removed preview in the production tier as InvalidArgument", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      await projectIn(session.organization.id, "event-prod");

      const error = await clientFor(session.token)
        .recordEnvironmentEvent({
          event: {
            kind: EnvironmentEventKind.PREVIEW_REMOVED,
            slug: "event-prod",
            environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
            at: timestampFromDate(new Date()),
          },
        })
        .catch((e: unknown) => e);

      expect(ConnectError.from(error).code).toBe(Code.InvalidArgument);
    } finally {
      await session.cleanup();
    }
  });
});
