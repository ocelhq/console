import type { CloudJob } from "@console/api";
import { db } from "@console/db";
import { deployment, project } from "@console/db/schema";
import { and, eq } from "drizzle-orm";
import { deploymentHref } from "./deployment-view";

export interface JobPlace {
  project: { name: string; slug: string } | null;
  deploymentHref: string | null;
}

export async function placeOf(
  organizationId: string,
  job: Pick<CloudJob, "projectId" | "result">,
): Promise<JobPlace> {
  if (!job.projectId) {
    return { project: null, deploymentHref: null };
  }
  const [found] = await db
    .select({ id: project.id, name: project.name, slug: project.slug })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), eq(project.id, job.projectId)));
  if (!found) {
    return { project: null, deploymentHref: null };
  }
  const reported = job.result?.deploymentId;
  if (!reported) {
    return { project: { name: found.name, slug: found.slug }, deploymentHref: null };
  }
  const [row] = await db
    .select({ id: deployment.id })
    .from(deployment)
    .where(and(eq(deployment.projectId, found.id), eq(deployment.deploymentId, reported)));
  return {
    project: { name: found.name, slug: found.slug },
    deploymentHref: row ? deploymentHref(found.slug, row.id) : null,
  };
}
