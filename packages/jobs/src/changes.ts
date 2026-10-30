import { db } from "@console/db";
import { type Job, job } from "@console/db/schema";
import { and, eq, lt, sql } from "drizzle-orm";

export type Notify = (changed: Job) => Promise<void>;

export const changed = () => ({
  revision: sql`${job.revision} + 1`,
  changedAt: sql`now()`,
});

export async function markSynced(id: string, revision: number): Promise<void> {
  await db
    .update(job)
    .set({ syncedRevision: revision })
    .where(and(eq(job.id, id), lt(job.syncedRevision, revision)));
}

// The change is committed; a notice lost here is sent again by resync.
export async function announce(rows: readonly Job[], notify: Notify): Promise<void> {
  for (const row of rows) {
    await notify(row).catch((error: unknown) => {
      console.error("jobs: a job change went unannounced until resync", { id: row.id, error });
    });
  }
}

export async function resync(notify: Notify): Promise<Job[]> {
  const unreported = await db
    .select()
    .from(job)
    .where(
      and(
        sql`${job.revision} <> ${job.syncedRevision}`,
        sql`${job.changedAt} < now() - interval '1 minute'`,
        sql`${job.changedAt} > now() - interval '1 day'`,
      ),
    );
  const failures: unknown[] = [];
  for (const row of unreported) {
    try {
      await notify(row);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} job changes went unreported`);
  }
  return unreported;
}
