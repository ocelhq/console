import { db } from "@console/db";
import { job, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "@/test/auth-harness";
import { activityJob, activityTitle, jobActivity, RECENT_MS } from "./job-activity";

beforeAll(async () => {
  await setupTestDatabase();
});

async function projectIn(organizationId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, organizationId, name: "Shop", slug: `shop-${id}` });
  return id;
}

async function ran(projectId: string, over: Partial<typeof job.$inferInsert>): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(job).values({
    id,
    projectId,
    kind: "preview-rm",
    tier: "preview",
    status: "running",
    lane: `lane-${id}`,
    dedupeKey: id,
    eventAt: new Date(),
    runnerId: "ocel-cloud",
    ...over,
  });
  return id;
}

describe("jobActivity", () => {
  it("lists a tier's removals and destroys that are running or ended lately, and no deploys", async () => {
    const session = await createTestSessionWithOrganization();
    try {
      const projectId = await projectIn(session.organization.id);
      const now = new Date();
      const asking = await ran(projectId, { status: "input-required", lane: "feature" });
      const lately = await ran(projectId, { status: "done", finishedAt: now });
      await ran(projectId, {
        status: "done",
        finishedAt: new Date(now.getTime() - RECENT_MS - 1000),
      });
      await ran(projectId, { kind: "deploy" });
      await ran(projectId, { runnerId: null, status: "done", finishedAt: now });
      const destroy = await ran(projectId, { kind: "projects-destroy", tier: "production" });

      const listed = await jobActivity(projectId, "preview", now);

      expect(listed.map((row) => row.id).sort()).toEqual([asking, lately].sort());
      expect(await activityJob(projectId, asking)).toMatchObject({ status: "input-required" });
      expect((await jobActivity(projectId, "production", now)).map((row) => row.id)).toEqual([
        destroy,
      ]);
    } finally {
      await session.cleanup();
    }
  });
});

describe("activityTitle", () => {
  it("names what the job removes or destroys", () => {
    expect(activityTitle({ kind: "preview-rm", lane: "pr-7", tier: "preview" })).toBe(
      "Removing preview pr-7",
    );
    expect(activityTitle({ kind: "projects-destroy", lane: "", tier: "production" })).toBe(
      "Destroying production",
    );
  });
});
