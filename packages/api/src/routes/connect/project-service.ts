import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import type { ProjectService } from "@console/connectors/gen/console/v1/project_pb";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { sessionOf } from "./session";

function isUniqueConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ((error as { code?: string }).code === "23505") {
    return true;
  }
  return isUniqueConstraintViolation((error as { cause?: unknown }).cause);
}

function projectMessage(row: typeof project.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    description: row.description ?? undefined,
  };
}

export const projectService: ServiceImpl<typeof ProjectService> = {
  async create(request, context) {
    const session = sessionOf(context);
    try {
      const [created] = await db
        .insert(project)
        .values({
          id: uuidv7(),
          organizationId: session.activeOrganizationId,
          name: request.name,
          slug: request.slug,
          description: request.description ?? null,
          createdBy: session.userId,
        })
        .returning();
      if (!created) {
        throw new ConnectError("the insert returned no project", Code.Internal);
      }
      return { project: projectMessage(created) };
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConnectError(
          "A project with this slug already exists in this organization",
          Code.AlreadyExists,
        );
      }
      throw error;
    }
  },

  async list(_request, context) {
    const rows = await db
      .select()
      .from(project)
      .where(eq(project.organizationId, sessionOf(context).activeOrganizationId))
      .orderBy(project.createdAt);
    return { projects: rows.map(projectMessage) };
  },
};
