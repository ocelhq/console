import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  AppOutcome,
  ComputeKind,
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
  connectClient,
  deploymentRecord,
  projectIn,
  TRACE_ID,
} from "../../../test/connect-harness";

describe("DeploymentService over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  describe("the session", () => {
    it("returns Unauthenticated for a call with no session", async () => {
      const error = await connectClient(null)
        .report({ projectId: crypto.randomUUID(), deployment: deploymentRecord() })
        .catch((e: unknown) => e);
      expect(ConnectError.from(error).code).toBe(Code.Unauthenticated);
    });

    it("returns Unauthenticated for a bearer that is not a session", async () => {
      const error = await connectClient("not-a-session")
        .report({ projectId: crypto.randomUUID(), deployment: deploymentRecord() })
        .catch((e: unknown) => e);
      expect(ConnectError.from(error).code).toBe(Code.Unauthenticated);
    });
  });

  describe("Report", () => {
    it("stores the deployment in the named project", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "report-stores");

        await connectClient(session.token).report({ projectId, deployment: deploymentRecord() });

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
          framework: "next",
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

    it("stores a repeated run once", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "report-twice");
        const client = connectClient(session.token);

        await client.report({ projectId, deployment: deploymentRecord() });
        await client.report({ projectId, deployment: deploymentRecord() });

        const rows = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
        expect(rows).toHaveLength(1);
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound for a project that does not exist", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const error = await connectClient(session.token)
          .report({ projectId: crypto.randomUUID(), deployment: deploymentRecord() })
          .catch((e: unknown) => e);
        expect(ConnectError.from(error).code).toBe(Code.NotFound);
      } finally {
        await session.cleanup();
      }
    });

    it("returns NotFound and stores nothing for a project the session's organization does not own", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        const foreign = await projectIn(other.organization.id, "shop");

        const error = await connectClient(session.token)
          .report({ projectId: foreign, deployment: deploymentRecord() })
          .catch((e: unknown) => e);

        expect(ConnectError.from(error).code).toBe(Code.NotFound);
        const rows = await db.select().from(deployment).where(eq(deployment.projectId, foreign));
        expect(rows).toHaveLength(0);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });

    it("stores into the named project when another organization has a project with the same slug", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        const mine = await projectIn(session.organization.id, "shop");
        const foreign = await projectIn(other.organization.id, "shop");

        await connectClient(session.token).report({
          projectId: mine,
          deployment: deploymentRecord(),
        });

        expect(
          await db.select().from(deployment).where(eq(deployment.projectId, mine)),
        ).toHaveLength(1);
        expect(
          await db.select().from(deployment).where(eq(deployment.projectId, foreign)),
        ).toHaveLength(0);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });

    it("returns InvalidArgument for a succeeded deployment that names no promotion", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "no-promotion");

        const error = await connectClient(session.token)
          .report({ projectId, deployment: deploymentRecord({ promotion: undefined }) })
          .catch((e: unknown) => e);

        const refused = ConnectError.from(error);
        expect(refused.code).toBe(Code.InvalidArgument);
        expect(refused.rawMessage).toContain("a succeeded deployment names the promotion");
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for a failed deployment that names a promotion", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "failed-promotion");

        const error = await connectClient(session.token)
          .report({
            projectId,
            deployment: deploymentRecord({ outcome: DeploymentOutcome.FAILED }),
          })
          .catch((e: unknown) => e);

        const refused = ConnectError.from(error);
        expect(refused.code).toBe(Code.InvalidArgument);
        expect(refused.rawMessage).toContain("deployment.no_promotion_on_failure");
      } finally {
        await session.cleanup();
      }
    });

    it("stores an app that names no runtime with no runtime", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "no-runtime");
        await connectClient(session.token).report({
          projectId,
          deployment: deploymentRecord({
            apps: [{ name: "web", compute: ComputeKind.SERVERLESS, outcome: AppOutcome.SKIPPED }],
          }),
        });

        const [row] = await db.select().from(deployment).where(eq(deployment.projectId, projectId));
        expect(row?.topology.apps[0]).not.toHaveProperty("runtime");
      } finally {
        await session.cleanup();
      }
    });

    it("stores the spans as the run's trace", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "report-spans");

        await connectClient(session.token).report({
          projectId,
          deployment: deploymentRecord({
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
  });

  describe("RecordEnvironmentEvent", () => {
    it("stores a removed preview", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "event-stores");

        await connectClient(session.token).recordEnvironmentEvent({
          projectId,
          event: create(EnvironmentEventSchema, {
            id: TRACE_ID,
            kind: EnvironmentEventKind.PREVIEW_REMOVED,
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
          ci: { provider: "github", repo: "ocelhq/app" },
        });
        expect(row?.git).toEqual({ branch: "feat/x", dirty: false });
        expect(row?.occurredAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
      } finally {
        await session.cleanup();
      }
    });

    it("stores a retried event once", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "event-twice");
        const client = connectClient(session.token);
        const event = {
          id: TRACE_ID,
          kind: EnvironmentEventKind.DESTROYED,
          environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
          at: timestampFromDate(new Date("2026-01-02T00:00:00.000Z")),
        };

        await client.recordEnvironmentEvent({ projectId, event });
        await client.recordEnvironmentEvent({ projectId, event });

        const rows = await db
          .select()
          .from(environmentEvent)
          .where(eq(environmentEvent.projectId, projectId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.runId).toBe(TRACE_ID);
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for a removed preview in the production tier", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const projectId = await projectIn(session.organization.id, "event-prod");

        const error = await connectClient(session.token)
          .recordEnvironmentEvent({
            projectId,
            event: {
              id: TRACE_ID,
              kind: EnvironmentEventKind.PREVIEW_REMOVED,
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

    it("returns NotFound and stores nothing for a project the session's organization does not own", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        const foreign = await projectIn(other.organization.id, "shop");

        const error = await connectClient(session.token)
          .recordEnvironmentEvent({
            projectId: foreign,
            event: {
              id: TRACE_ID,
              kind: EnvironmentEventKind.DESTROYED,
              environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
              at: timestampFromDate(new Date()),
            },
          })
          .catch((e: unknown) => e);

        expect(ConnectError.from(error).code).toBe(Code.NotFound);
        const rows = await db
          .select()
          .from(environmentEvent)
          .where(eq(environmentEvent.projectId, foreign));
        expect(rows).toHaveLength(0);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });
  });
});
