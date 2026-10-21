import { db } from "@console/db";
import { deployment, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "@/test/auth-harness";
import { placeOf } from "./cloud-job-place";

async function projectIn(organizationId: string) {
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, organizationId, name: "Shop", slug: `shop-${id}` });
  return id;
}

async function deploymentOf(projectId: string, deploymentId: string) {
  const id = crypto.randomUUID();
  await db.insert(deployment).values({
    id,
    projectId,
    deploymentId,
    kind: "deploy",
    tier: "production",
    providerName: "ocel",
    target: "ocel/cloud",
    outcome: "succeeded",
    trigger: { kind: "cli" },
    deployedAt: new Date(),
    trace: [],
    topology: { apps: [], resources: [], usages: [] },
  });
  return id;
}

describe("placeOf", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  it("names the job's project and links the deployment it reported", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      const row = await deploymentOf(projectId, "dep-cloud-1");

      const place = await placeOf(session.organization.id, session.organization.id, {
        projectId,
        result: { urls: [], builds: [], deploymentId: "dep-cloud-1" },
      });

      expect(place.project?.name).toBe("Shop");
      expect(place.otherOrganization).toBeNull();
      expect(place.deploymentHref).toBe(`/projects/${place.project?.slug}/deployments/${row}`);
    } finally {
      await session.cleanup();
    }
  });

  it("links no deployment the console has not been told about", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      const place = await placeOf(session.organization.id, session.organization.id, {
        projectId,
        result: { urls: [], builds: [], deploymentId: "dep-unreported" },
      });
      expect(place.project).not.toBeNull();
      expect(place.deploymentHref).toBeNull();
    } finally {
      await session.cleanup();
    }
  });

  it("shows nothing of a project in another organization", async () => {
    const owner = await createTestSessionWithOrganization();
    const viewer = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(owner.organization.id);
      await deploymentOf(projectId, "dep-cloud-2");

      expect(
        await placeOf(viewer.organization.id, viewer.organization.id, {
          projectId,
          result: { urls: [], builds: [], deploymentId: "dep-cloud-2" },
        }),
      ).toEqual({ project: null, deploymentHref: null, otherOrganization: null });
    } finally {
      await owner.cleanup();
      await viewer.cleanup();
    }
  });

  it("names the job's organization when it isn't the active one, so no link opens the wrong project", async () => {
    const owner = await createTestSessionWithOrganization();
    const other = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(owner.organization.id);
      await deploymentOf(projectId, "dep-cloud-3");

      const place = await placeOf(owner.organization.id, other.organization.id, {
        projectId,
        result: { urls: [], builds: [], deploymentId: "dep-cloud-3" },
      });

      expect(place.project?.name).toBe("Shop");
      expect(place.otherOrganization).toBe("Test Org");
    } finally {
      await owner.cleanup();
      await other.cleanup();
    }
  });
});
