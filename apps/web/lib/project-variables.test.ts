import { connect, upsertConnector } from "@console/api";
import { VariableClass } from "@console/connectors/gen/app/resources/v1/variables_pb";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  AppOutcome,
  ComputeKind,
  DeploymentKind,
  DeploymentOutcome,
  TriggerKind,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "@/test/auth-harness";
import { connectorFor } from "./connectors";
import { latestTopology } from "./project-variables";

const TARGET = "aws/123456789012/us-east-1/main";

function reportRequest(token: string, projectId: string): Request {
  return new Request("http://localhost/api/connect/console.v1.DeploymentService/Report", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      deployment: {
        id: "0af7651916cd43dd8448eb211c80319c",
        kind: DeploymentKind.DEPLOY,
        outcome: DeploymentOutcome.SUCCEEDED,
        environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
        provider: { name: "aws", region: "us-east-1" },
        target: TARGET,
        startedAt: "2025-12-31T23:58:00Z",
        finishedAt: "2026-01-01T00:00:00Z",
        promotion: { id: "prm-1", seq: "1" },
        trigger: { kind: TriggerKind.CLI },
        apps: [
          {
            name: "web",
            compute: ComputeKind.SERVERLESS,
            outcome: AppOutcome.SUCCEEDED,
            buildId: "build-1",
            release: "rel-1",
            variables: [
              {
                key: "DATABASE_URL",
                class: VariableClass.SECRET,
                folders: ["/web"],
                required: true,
              },
              { key: "PUBLIC_URL", class: VariableClass.PLAIN },
            ],
          },
        ],
      },
    }),
  });
}

describe("a deployment reported over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("gives the variables page its declared variables and the connector of the target it landed in", async () => {
    const session = await createTestSessionWithOrganization();
    const organizationId = session.organization.id;
    try {
      const projectId = crypto.randomUUID();
      await db
        .insert(project)
        .values({ id: projectId, organizationId, name: "Shop", slug: "shop" });

      const reported = await connect(reportRequest(session.token, projectId));
      expect(reported.status).toBe(200);
      const upserted = await upsertConnector(
        new Request("http://localhost/api/connectors", {
          method: "PUT",
          headers: { ...Object.fromEntries(session.headers), "Content-Type": "application/json" },
          body: JSON.stringify({ target: TARGET, vendor: "aws" }),
        }),
      );
      expect(upserted.status).toBe(200);

      const latest = await latestTopology(projectId, "production");
      if (latest.error || !latest.row) {
        throw new Error("the reported deployment is not the latest topology");
      }
      expect(latest.row.topology.apps[0]?.variables).toEqual([
        { key: "DATABASE_URL", class: "secret", folder: "/web", required: true },
        { key: "PUBLIC_URL", class: "plain", folder: "", required: false },
      ]);
      const found = await connectorFor(organizationId, latest.row.target);
      expect(found).toMatchObject({ organizationId, target: TARGET, vendor: "aws" });
    } finally {
      await session.cleanup();
    }
  });
});
