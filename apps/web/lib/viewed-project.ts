import { type ActiveOrganizationSession, verifyOrganizationMembership } from "@console/auth";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";

export interface ViewedProject {
  id: string;
  slug: string;
  viewer: ActiveOrganizationSession;
}

export async function viewedProject(
  session: ActiveOrganizationSession,
  where: { slug: string } | { id: string },
  organizationId: string = session.activeOrganizationId,
): Promise<ViewedProject | null> {
  if (
    organizationId !== session.activeOrganizationId &&
    !(await verifyOrganizationMembership(session.userId, organizationId))
  ) {
    return null;
  }
  const [found] = await db
    .select({ id: project.id, slug: project.slug })
    .from(project)
    .where(
      and(
        eq(project.organizationId, organizationId),
        "slug" in where ? eq(project.slug, where.slug) : eq(project.id, where.id),
      ),
    );
  return found
    ? { ...found, viewer: { userId: session.userId, activeOrganizationId: organizationId } }
    : null;
}
