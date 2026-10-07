import { db } from "@console/db";
import { deployment, environmentEvent, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "@/test/auth-harness";
import { findRun, latestDeployments, latestRuns, listRuns } from "./deployments";

const PREVIEW = { environmentClass: "preview", environmentIdentity: "pr-7" } as const;
const PRODUCTION = { environmentClass: "production", environmentIdentity: "" } as const;

type Place = typeof PREVIEW | typeof PRODUCTION;

async function projectIn(organizationId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, organizationId, name: "Shop", slug: `shop-${id}` });
  return id;
}

async function deployed(projectId: string, place: Place, at: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(deployment).values({
    id,
    projectId,
    runId: crypto.randomUUID().replaceAll("-", ""),
    kind: place.environmentClass === "preview" ? "preview-up" : "deploy",
    ...place,
    promotionId: `prm-${id}`,
    providerName: "aws",
    target: "aws/123456789012/us-east-1/main",
    outcome: "succeeded",
    trigger: { kind: "cli" },
    deployedAt: new Date(at),
    trace: [],
    topology: { apps: [], resources: [], usages: [] },
  });
  return id;
}

async function tornDown(projectId: string, place: Place, at: string) {
  await db.insert(environmentEvent).values({
    id: crypto.randomUUID(),
    projectId,
    runId: crypto.randomUUID().replaceAll("-", ""),
    kind: place.environmentClass === "preview" ? "preview-removed" : "destroyed",
    ...place,
    occurredAt: new Date(at),
  });
}

describe("active runs", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("drops a preview's last deployment once the preview is removed", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      const id = await deployed(projectId, PREVIEW, "2026-01-01T00:00:00.000Z");
      await tornDown(projectId, PREVIEW, "2026-01-02T00:00:00.000Z");

      const runs = await listRuns([projectId], null, null);
      expect(runs).toMatchObject({ error: false, rows: [{ id, active: false }] });
      expect(await findRun(projectId, id)).toMatchObject({ error: false, active: null });
    } finally {
      await session.cleanup();
    }
  });

  it("makes a redeploy after the removal active again", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      const removed = await deployed(projectId, PREVIEW, "2026-01-01T00:00:00.000Z");
      await tornDown(projectId, PREVIEW, "2026-01-02T00:00:00.000Z");
      const redeployed = await deployed(projectId, PREVIEW, "2026-01-03T00:00:00.000Z");

      const runs = await listRuns([projectId], null, null);
      expect(runs).toMatchObject({
        error: false,
        rows: [
          { id: redeployed, active: true },
          { id: removed, active: false },
        ],
      });
    } finally {
      await session.cleanup();
    }
  });
});

describe("latestDeployments", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("says when a destroyed environment was torn down", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      await deployed(projectId, PRODUCTION, "2026-01-01T00:00:00.000Z");
      await tornDown(projectId, PRODUCTION, "2026-01-02T00:00:00.000Z");

      expect(await latestDeployments(projectId, "production")).toMatchObject({
        error: false,
        tornDownAt: new Date("2026-01-02T00:00:00.000Z"),
      });
    } finally {
      await session.cleanup();
    }
  });

  it("does not call an environment redeployed after its teardown torn down", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      await deployed(projectId, PRODUCTION, "2026-01-01T00:00:00.000Z");
      await tornDown(projectId, PRODUCTION, "2026-01-02T00:00:00.000Z");
      await deployed(projectId, PRODUCTION, "2026-01-03T00:00:00.000Z");

      expect(await latestDeployments(projectId, "production")).toMatchObject({
        error: false,
        tornDownAt: null,
      });
    } finally {
      await session.cleanup();
    }
  });
});

describe("latestRuns", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("says when a project's production environment was destroyed after its last deploy", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      await deployed(projectId, PRODUCTION, "2026-01-01T00:00:00.000Z");
      await tornDown(projectId, PRODUCTION, "2026-01-02T00:00:00.000Z");

      const runs = await latestRuns([projectId]);
      expect(runs.get(projectId)).toMatchObject({
        tornDownAt: new Date("2026-01-02T00:00:00.000Z"),
      });
    } finally {
      await session.cleanup();
    }
  });

  it("does not call a project redeployed after its destroy torn down", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      await deployed(projectId, PRODUCTION, "2026-01-01T00:00:00.000Z");
      await tornDown(projectId, PRODUCTION, "2026-01-02T00:00:00.000Z");
      await deployed(projectId, PRODUCTION, "2026-01-03T00:00:00.000Z");

      const runs = await latestRuns([projectId]);
      expect(runs.get(projectId)).toMatchObject({ tornDownAt: null });
    } finally {
      await session.cleanup();
    }
  });
});
