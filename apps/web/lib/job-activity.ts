import { db } from "@console/db";
import { ACTIVE_JOB_STATUSES, type Job, job, type Tier } from "@console/db/schema";
import { and, desc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";

export const ACTIVITY_KINDS = ["preview-rm", "projects-destroy"] as const;

export const RECENT_MS = 24 * 60 * 60 * 1000;

const isActivity = and(inArray(job.kind, [...ACTIVITY_KINDS]), isNotNull(job.runnerId));

export async function jobActivity(projectId: string, tier: Tier, now: Date): Promise<Job[]> {
  return db
    .select()
    .from(job)
    .where(
      and(
        eq(job.projectId, projectId),
        eq(job.tier, tier),
        isActivity,
        or(
          inArray(job.status, [...ACTIVE_JOB_STATUSES]),
          gt(job.finishedAt, new Date(now.getTime() - RECENT_MS)),
        ),
      ),
    )
    .orderBy(desc(job.createdAt))
    .limit(5);
}

export async function activityJob(projectId: string, id: string): Promise<Job | undefined> {
  const [found] = await db
    .select()
    .from(job)
    .where(and(eq(job.projectId, projectId), eq(job.id, id), isActivity));
  return found;
}

export function activityTitle(row: Pick<Job, "kind" | "lane" | "tier">): string {
  return row.kind === "preview-rm"
    ? `Removing preview ${row.lane || "(unnamed)"}`
    : `Destroying ${row.tier}`;
}

export function activityHref(slug: string, id: string): string {
  return `/projects/${slug}/jobs/${id}`;
}
