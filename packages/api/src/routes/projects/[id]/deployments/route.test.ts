import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { DeploymentKind } from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { deployment } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "../../../../../test/auth-harness";
import {
  connectClient,
  deploymentRecord,
  projectIn,
  TRACE_ID,
} from "../../../../../test/connect-harness";
import { getDeployment, listDeployments } from "./route";

type ListedRow = { promotionId: string };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function listRequest(headers: Headers, query = "") {
  return new Request(`http://localhost/api/projects/x/deployments${query}`, { headers });
}

async function idOf(projectId: string, deploymentId: string): Promise<string> {
  const [row] = await db
    .select({ id: deployment.id })
    .from(deployment)
    .where(and(eq(deployment.projectId, projectId), eq(deployment.deploymentId, deploymentId)));
  if (!row) {
    throw new Error(`deployment ${deploymentId} was not recorded`);
  }
  return row.id;
}

describe("listDeployments", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("lists newest first and filters by environment", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "deploy-list");
      const client = connectClient(session.token);

      await client.report({
        projectId,
        deployment: deploymentRecord({
          id: "a".repeat(32),
          promotion: { id: "old", seq: 1n },
          finishedAt: timestampFromDate(new Date("2026-01-01T00:00:00.000Z")),
        }),
      });
      await client.report({
        projectId,
        deployment: deploymentRecord({
          id: "b".repeat(32),
          promotion: { id: "new", seq: 2n },
          finishedAt: timestampFromDate(new Date("2026-02-01T00:00:00.000Z")),
        }),
      });
      await client.report({
        projectId,
        deployment: deploymentRecord({
          id: "c".repeat(32),
          kind: DeploymentKind.PREVIEW_UP,
          promotion: { id: "pr-7", seq: 1n },
          finishedAt: timestampFromDate(new Date("2026-03-01T00:00:00.000Z")),
          environment: { tier: Tier.PREVIEW, lifecycle: Lifecycle.EPHEMERAL, identity: "pr-7" },
        }),
      });

      const all = await listDeployments(listRequest(session.headers), projectId);
      expect(all.status).toBe(200);
      const rows = await readJson<(ListedRow & Record<string, unknown>)[]>(all);
      expect(rows.map((row) => row.promotionId)).toEqual(["pr-7", "new", "old"]);
      expect(rows[0]).toMatchObject({
        deploymentId: "c".repeat(32),
        kind: "preview-up",
        trigger: { kind: "ci", actor: "victor" },
        git: { sha: "0123456789abcdef", branch: "main", dirty: false },
        startedAt: Date.parse("2025-12-31T23:58:00.000Z"),
        environment: { tier: "preview", identity: "pr-7" },
        provider: { name: "aws", region: "us-east-1" },
        target: "aws/123456789012/us-east-1/main",
        tag: null,
        edgeKind: "cloudfront",
        error: null,
        apps: [{ name: "web", outcome: "succeeded", urls: ["https://web.example.com"] }],
      });

      const production = await listDeployments(
        listRequest(session.headers, "?env=production"),
        projectId,
      );
      expect((await readJson<ListedRow[]>(production)).map((row) => row.promotionId)).toEqual([
        "new",
        "old",
      ]);

      const preview = await listDeployments(
        listRequest(session.headers, "?env=preview"),
        projectId,
      );
      expect((await readJson<ListedRow[]>(preview)).map((row) => row.promotionId)).toEqual([
        "pr-7",
      ]);
    } finally {
      await session.cleanup();
    }
  });

  it("answers 404 for a Project in an org the caller doesn't belong to", async () => {
    const session = await createTestSessionWithOrganization();
    const stranger = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "deploy-list-foreign");

      const response = await listDeployments(listRequest(stranger.headers), projectId);

      expect(response.status).toBe(404);
    } finally {
      await session.cleanup();
      await stranger.cleanup();
    }
  });

  it("answers 401 when unauthenticated", async () => {
    const response = await listDeployments(
      listRequest(new Headers()),
      "00000000-0000-7000-8000-000000000000",
    );
    expect(response.status).toBe(401);
  });
});

describe("getDeployment", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("answers the full record with topology", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id, "deploy-get");
      await connectClient(session.token).report({ projectId, deployment: deploymentRecord() });
      const id = await idOf(projectId, TRACE_ID);

      const response = await getDeployment(listRequest(session.headers), projectId, id);

      expect(response.status).toBe(200);
      expect(await readJson<Record<string, unknown>>(response)).toMatchObject({
        id,
        trace: [],
        apps: [
          {
            name: "web",
            hostnames: ["web.example.com"],
            variables: [
              { key: "DATABASE_URL", folder: "/web" },
              { key: "DATABASE_URL", folder: "/api" },
            ],
          },
        ],
        resources: [{ name: "main", type: "postgres" }],
        usages: [{ app: "web", resource: "main" }],
      });
    } finally {
      await session.cleanup();
    }
  });

  it("answers 404 for a deployment of another project", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const mine = await projectIn(session.organization.id, "deploy-get-mine");
      const other = await projectIn(session.organization.id, "deploy-get-other");
      await connectClient(session.token).report({
        projectId: other,
        deployment: deploymentRecord(),
      });
      const id = await idOf(other, TRACE_ID);

      const response = await getDeployment(listRequest(session.headers), mine, id);

      expect(response.status).toBe(404);
    } finally {
      await session.cleanup();
    }
  });
});
