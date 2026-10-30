import { db } from "@console/db";
import { deployment, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "@/test/auth-harness";
import { recordRollback, rollbackable } from "./rollback";

beforeAll(async () => {
  await setupTestDatabase();
});

describe("recordRollback", () => {
  it("records the rollback as a deployment of its own, from the console, landing what it rolled back to", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = crypto.randomUUID();
      await db.insert(project).values({
        id: projectId,
        organizationId: session.organization.id,
        name: "Shop",
        slug: `shop-${projectId}`,
      });
      const from = {
        id: crypto.randomUUID(),
        projectId,
        deploymentId: crypto.randomUUID().replaceAll("-", ""),
        kind: "deploy" as const,
        tier: "production" as const,
        promotionId: "prm-old",
        tag: "v1",
        providerName: "aws",
        providerRegion: "us-east-1",
        target: "aws/123456789012/us-east-1/main",
        edgeKind: "cloudfront",
        outcome: "succeeded" as const,
        outcomeBy: "ocel" as const,
        trigger: { kind: "cli" as const },
        deployedAt: new Date("2026-01-01T00:00:00Z"),
        topology: {
          apps: [
            {
              name: "web",
              compute: "serverless" as const,
              release: "rel-old",
              urls: ["https://web.example.com"],
              hostnames: [],
              outcome: "succeeded" as const,
              variables: [],
            },
          ],
          resources: [],
          usages: [],
        },
      };
      await db.insert(deployment).values(from);
      const [stored] = await db.select().from(deployment).where(eq(deployment.id, from.id));
      if (!stored) throw new Error("the deployment was not stored");

      const id = await recordRollback(
        stored,
        { promotionId: "prm-new", releases: { web: "rel-back" } },
        session.user.id,
      );

      const [row] = await db.select().from(deployment).where(eq(deployment.id, id));
      expect(row).toMatchObject({
        projectId,
        kind: "rollback",
        tier: "production",
        promotionId: "prm-new",
        tag: "v1",
        providerName: "aws",
        target: from.target,
        edgeKind: "cloudfront",
        outcome: "succeeded",
        trigger: { kind: "console", actor: session.user.name },
        principal: { kind: "session", userId: session.user.id },
      });
      expect(row?.deploymentId).toMatch(/^[0-9a-f]{32}$/);
      expect(row?.deployedAt).toBeInstanceOf(Date);
      expect(row?.topology.apps[0]).toMatchObject({ name: "web", release: "rel-back" });
    } finally {
      await session.cleanup();
    }
  });
});

describe("rollbackable", () => {
  const promoted = {
    id: "d",
    tier: "production" as const,
    outcome: "succeeded" as const,
    promotionId: "prm",
  };

  it("is a production promotion that succeeded and is no longer live", () => {
    expect(rollbackable(promoted, { id: "newer" })).toBe(true);
    expect(rollbackable(promoted, null)).toBe(true);
  });

  it("is not the live promotion, a failure, a preview, or a deploy with no promotion", () => {
    expect(rollbackable(promoted, { id: "d" })).toBe(false);
    expect(rollbackable({ ...promoted, outcome: "failed" }, null)).toBe(false);
    expect(rollbackable({ ...promoted, tier: "preview" }, null)).toBe(false);
    expect(rollbackable({ ...promoted, promotionId: null }, null)).toBe(false);
  });
});
