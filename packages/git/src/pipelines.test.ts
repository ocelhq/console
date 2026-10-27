import { db } from "@console/db";
import { organization, pipelineToken, project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPipeline,
  forgetExpiredPipelineTokens,
  parseBranches,
  parseRepository,
  parseWorkflow,
  pinPipeline,
  pipelinesOf,
  removePipeline,
  spendPipelineToken,
} from "./pipelines";

const suffix = crypto.randomUUID();
const orgId = `org-${suffix}`;
const projectId = `p-${suffix}`;

beforeAll(async () => {
  await setupTestDatabase();
  await db
    .insert(organization)
    .values({ id: orgId, name: "A", slug: orgId, createdAt: new Date() });
  await db.insert(project).values({ id: projectId, organizationId: orgId, name: "P", slug: "p" });
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, orgId));
  await pg.end();
});

describe("parsing what an admin types", () => {
  it("takes a repository as owner/name, or as its GitHub url", () => {
    expect(parseRepository(" acme/web ")).toBe("acme/web");
    expect(parseRepository("https://github.com/acme/web.git")).toBe("acme/web");
    expect(parseRepository("acme")).toBeUndefined();
    expect(parseRepository("acme/web/extra")).toBeUndefined();
    expect(parseRepository("acme/..")).toBeUndefined();
  });

  it("takes a workflow as its path in the repository, or none", () => {
    expect(parseWorkflow(".github/workflows/preview.yml")).toBe(".github/workflows/preview.yml");
    expect(parseWorkflow("")).toBeNull();
    expect(parseWorkflow("preview.yml")).toBeUndefined();
  });

  it("takes branch patterns separated by commas or spaces, all branches when none", () => {
    expect(parseBranches("main, release/*  main")).toEqual(["main", "release/*"]);
    expect(parseBranches("  ")).toEqual(["*"]);
  });
});

describe("a trusted pipeline", () => {
  it("is pinned to the first repository ids seen, and only once", async () => {
    const added = await addPipeline({
      projectId,
      repository: "acme/private",
      repositoryId: null,
      repositoryOwnerId: null,
      workflow: null,
      environment: null,
      branches: ["*"],
      origin: "manual",
      createdBy: null,
    });

    expect(
      await pinPipeline(added.id, { repositoryId: "1", repositoryOwnerId: "2" }),
    ).toMatchObject({ repositoryId: "1", repositoryOwnerId: "2" });
    expect(
      await pinPipeline(added.id, { repositoryId: "9", repositoryOwnerId: "9" }),
    ).toBeUndefined();
    expect((await pipelinesOf(projectId))[0]).toMatchObject({ repositoryId: "1" });
  });

  it("is removed only from its own project", async () => {
    const [added] = await pipelinesOf(projectId);
    if (!added) throw new Error("none");

    expect(await removePipeline("another-project", added.id)).toBe(false);
    expect(await removePipeline(projectId, added.id)).toBe(true);
    expect(await pipelinesOf(projectId)).toEqual([]);
  });
});

describe("a pipeline token", () => {
  it("is spent once, and forgotten once it expires", async () => {
    const jti = `jti-${suffix}`;
    const expired = `expired-${suffix}`;

    expect(await spendPipelineToken("iss", jti, new Date(Date.now() + 60_000))).toBe(true);
    expect(await spendPipelineToken("iss", jti, new Date(Date.now() + 60_000))).toBe(false);
    expect(await spendPipelineToken("iss", expired, new Date(Date.now() - 1000))).toBe(true);

    await forgetExpiredPipelineTokens();

    const kept = (await db.select().from(pipelineToken)).map((row) => row.jti);
    expect(kept).toContain(jti);
    expect(kept).not.toContain(expired);
  });
});
