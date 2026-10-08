import { Code, ConnectError } from "@connectrpc/connect";
import { ProjectService } from "@console/connectors/gen/console/v1/project_pb";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestSessionWithOrganization } from "../../../test/auth-harness";
import { serviceClient } from "../../../test/connect-harness";

function projects(bearer: string | null) {
  return serviceClient(ProjectService, bearer);
}

async function codeOf(call: Promise<unknown>): Promise<Code> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  return ConnectError.from(error).code;
}

describe("ProjectService over Connect", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  describe("the session", () => {
    it("returns Unauthenticated for a Create with no session", async () => {
      expect(await codeOf(projects(null).create({ name: "Shop", slug: "shop" }))).toBe(
        Code.Unauthenticated,
      );
    });

    it("returns Unauthenticated for a List with no session", async () => {
      expect(await codeOf(projects(null).list({}))).toBe(Code.Unauthenticated);
    });
  });

  describe("Create", () => {
    it("creates a project in the session's active organization", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const response = await projects(session.token).create({
          name: "My Project",
          slug: "my-project",
          description: "desc",
        });

        expect(response.project).toMatchObject({
          name: "My Project",
          slug: "my-project",
          description: "desc",
          organizationId: session.organization.id,
        });
        expect(response.project?.id).toBeTruthy();

        const [row] = await db
          .select()
          .from(project)
          .where(
            and(
              eq(project.organizationId, session.organization.id),
              eq(project.slug, "my-project"),
            ),
          );
        expect(row?.createdBy).toBe(session.user.id);
        expect(row?.name).toBe("My Project");
      } finally {
        await session.cleanup();
      }
    });

    it("leaves the description unset when the request names none", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        const response = await projects(session.token).create({ name: "Shop", slug: "shop" });
        expect(response.project?.description).toBeUndefined();
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for a slug that is not a slug", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        expect(
          await codeOf(projects(session.token).create({ name: "My Project", slug: "Not A Slug!" })),
        ).toBe(Code.InvalidArgument);
      } finally {
        await session.cleanup();
      }
    });

    it("returns InvalidArgument for an empty name", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        expect(await codeOf(projects(session.token).create({ name: "", slug: "my-project" }))).toBe(
          Code.InvalidArgument,
        );
      } finally {
        await session.cleanup();
      }
    });

    it("returns AlreadyExists for a duplicate slug within the same organization", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        await projects(session.token).create({ name: "First", slug: "dup-slug" });

        expect(
          await codeOf(projects(session.token).create({ name: "Second", slug: "dup-slug" })),
        ).toBe(Code.AlreadyExists);
      } finally {
        await session.cleanup();
      }
    });

    it("lets two organizations reuse the same slug", async () => {
      const first = await createTestSessionWithOrganization();
      const second = await createTestSessionWithOrganization();
      try {
        await projects(first.token).create({ name: "Org A", slug: "shared-slug" });
        const created = await projects(second.token).create({ name: "Org B", slug: "shared-slug" });
        expect(created.project?.organizationId).toBe(second.organization.id);
      } finally {
        await first.cleanup();
        await second.cleanup();
      }
    });
  });

  describe("List", () => {
    it("lists every project in the active organization and none from another", async () => {
      const session = await createTestSessionWithOrganization();
      const other = await createTestSessionWithOrganization();
      try {
        await projects(session.token).create({ name: "Alpha", slug: "alpha" });
        await projects(session.token).create({ name: "Beta", slug: "beta" });
        await projects(other.token).create({ name: "Not Mine", slug: "not-mine" });

        const { projects: listed } = await projects(session.token).list({});

        expect(listed.map((p) => p.slug)).toEqual(["alpha", "beta"]);
        expect(listed.every((p) => p.organizationId === session.organization.id)).toBe(true);
      } finally {
        await session.cleanup();
        await other.cleanup();
      }
    });

    it("lists nothing for an organization with no projects", async () => {
      const session = await createTestSessionWithOrganization();
      try {
        expect((await projects(session.token).list({})).projects).toEqual([]);
      } finally {
        await session.cleanup();
      }
    });
  });
});
