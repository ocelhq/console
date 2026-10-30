import { db } from "@console/db";
import { project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization, createTestSessionWithRole } from "@/test/auth-harness";
import { viewedProject } from "./viewed-project";

async function projectIn(organizationId: string, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, organizationId, name: "Shop", slug });
  return id;
}

beforeAll(async () => {
  await setupTestDatabase();
});

describe("viewedProject", () => {
  it("finds the project in the organization a link names, for a member of it whose active organization is another", async () => {
    const linked = await createTestSessionWithOrganization();
    const active = await createTestSessionWithOrganization();
    const viewer = await createTestSessionWithRole(linked.organization.id, "member");
    try {
      const id = await projectIn(linked.organization.id, "shop");
      const session = { userId: viewer.user.id, activeOrganizationId: active.organization.id };

      expect(await viewedProject(session, { slug: "shop" }, linked.organization.id)).toEqual({
        id,
        slug: "shop",
        viewer: { userId: viewer.user.id, activeOrganizationId: linked.organization.id },
      });
      expect(await viewedProject(session, { slug: "shop" })).toBeNull();
    } finally {
      await viewer.cleanup();
      await active.cleanup();
      await linked.cleanup();
    }
  });

  it("finds nothing in an organization the viewer does not belong to", async () => {
    const theirs = await createTestSessionWithOrganization();
    const mine = await createTestSessionWithOrganization();
    try {
      await projectIn(theirs.organization.id, "shop");
      const session = { userId: mine.user.id, activeOrganizationId: mine.organization.id };

      expect(await viewedProject(session, { slug: "shop" }, theirs.organization.id)).toBeNull();
    } finally {
      await mine.cleanup();
      await theirs.cleanup();
    }
  });
});
