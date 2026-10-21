import type { CloudJob } from "@console/api";
import { db } from "@console/db";
import { deployment, organization, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { deploymentHref } from "./deployment-view";

export interface JobPlace {
  project: { name: string; slug: string } | null;
  deploymentHref: string | null;
  otherOrganization: string | null;
}

const nowhere: JobPlace = { project: null, deploymentHref: null, otherOrganization: null };

export async function placeOf(
  organizationId: string,
  activeOrganizationId: string,
  job: Pick<CloudJob, "projectId" | "result">,
): Promise<JobPlace> {
  if (!job.projectId) {
    return nowhere;
  }
  const [found] = await db
    .select({
      id: project.id,
      name: project.name,
      slug: project.slug,
      organization: organization.name,
    })
    .from(project)
    .innerJoin(organization, eq(organization.id, project.organizationId))
    .where(and(eq(project.organizationId, organizationId), eq(project.id, job.projectId)));
  if (!found) {
    return nowhere;
  }
  const place = {
    project: { name: found.name, slug: found.slug },
    otherOrganization: organizationId === activeOrganizationId ? null : found.organization,
  };
  const reported = job.result?.deploymentId;
  if (!reported) {
    return { ...place, deploymentHref: null };
  }
  const [row] = await db
    .select({ id: deployment.id })
    .from(deployment)
    .where(and(eq(deployment.projectId, found.id), eq(deployment.deploymentId, reported)));
  return { ...place, deploymentHref: row ? deploymentHref(found.slug, row.id) : null };
}
