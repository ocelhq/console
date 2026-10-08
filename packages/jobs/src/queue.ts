import { db } from "@console/db";
import { type Job, job, runner } from "@console/db/schema";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

const LEASE_SECONDS = 60;
const CLAIM_ATTEMPTS = 3;
const CLAIMS_BEFORE_FAILING = 3;
const UNIQUE_VIOLATION = "23505";
const MANAGED_LABEL = "managed";

export const HELD_STATUSES: Job["status"][] = ["claimed", "running"];

export interface JobQueueOptions {
  notify?: (changed: Job) => Promise<void>;
}

export interface Finished {
  outcome: "succeeded" | "failed";
  deploymentId?: string;
  error?: string;
}

export const changed = () => ({
  revision: sql`${job.revision} + 1`,
  changedAt: sql`now()`,
});

const lease = () => sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: string }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

export async function markSynced(id: string, revision: number): Promise<void> {
  await db
    .update(job)
    .set({ syncedRevision: revision })
    .where(and(eq(job.id, id), lt(job.syncedRevision, revision)));
}

export async function reportAll(rows: Job[], notify: (changed: Job) => Promise<void>) {
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      await notify(row);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} job changes went unreported`);
  }
}

export function jobQueue(options: JobQueueOptions = {}) {
  const notify = options.notify ?? (async () => {});

  const heldBy = (id: string, runnerId: string, ...statuses: Job["status"][]) =>
    and(eq(job.id, id), eq(job.runnerId, runnerId), inArray(job.status, statuses));

  async function tryClaim(held: {
    id: string;
    kind: "managed" | "self-hosted";
    organizationId: string | null;
    labels: string[];
  }): Promise<Job | undefined> {
    const labels = sql`array[${sql.join(
      held.labels.map((label) => sql`${label}`),
      sql`, `,
    )}]::text[]`;
    // A managed runner takes only a job that asks for one; an organization's own runner takes
    // any of its projects' jobs whose labels it holds, a job asking for none included.
    const scope =
      held.kind === "managed"
        ? sql`${MANAGED_LABEL} = any(j.labels)`
        : sql`p.organization_id = ${held.organizationId}`;
    const [claimed] = await db
      .update(job)
      .set({
        status: "claimed",
        runnerId: held.id,
        leaseUntil: lease(),
        claimedAt: sql`now()`,
        claims: sql`${job.claims} + 1`,
        ...changed(),
      })
      .where(
        sql`${job.id} = (
          select j.id from job j join project p on p.id = j.project_id
          where j.status = 'queued'
            and j.labels <@ ${labels}
            and ${scope}
            and not exists (
              select 1 from job o
              where o.project_id = j.project_id and o.pr = j.pr and o.status in ('claimed', 'running')
            )
          order by j.created_at, j.id
          limit 1
          for update of j skip locked
        )`,
      )
      .returning();
    return claimed;
  }

  return {
    async claim(runnerId: string): Promise<Job | undefined> {
      const [held] = await db
        .update(runner)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(runner.id, runnerId))
        .returning({
          id: runner.id,
          kind: runner.kind,
          organizationId: runner.organizationId,
          labels: runner.labels,
        });
      if (!held) throw new Error(`no runner ${runnerId}`);

      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        try {
          const claimed = await tryClaim(held);
          if (claimed) await notify(claimed);
          return claimed;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      return undefined;
    },

    async start(id: string, runnerId: string): Promise<Job | undefined> {
      const [running] = await db
        .update(job)
        .set({ status: "running", startedAt: sql`now()`, ...changed() })
        .where(heldBy(id, runnerId, "claimed"))
        .returning();
      if (running) await notify(running);
      return running;
    },

    async heartbeat(
      id: string,
      runnerId: string,
    ): Promise<{ cancelRequested: boolean } | undefined> {
      const [beat] = await db
        .update(job)
        .set({ leaseUntil: lease() })
        .where(heldBy(id, runnerId, ...HELD_STATUSES))
        .returning({ cancelRequested: job.cancelRequested });
      return beat;
    },

    async finish(id: string, runnerId: string, result: Finished): Promise<Job | undefined> {
      const [finished] = await db
        .update(job)
        .set({
          status:
            result.outcome === "succeeded"
              ? "done"
              : sql`case when ${job.cancelRequested} then 'canceled'::job_status else 'failed'::job_status end`,
          deploymentId: result.deploymentId ?? null,
          error: result.error ?? null,
          finishedAt: sql`now()`,
          leaseUntil: null,
          ...changed(),
        })
        .where(heldBy(id, runnerId, ...HELD_STATUSES))
        .returning();
      if (finished) await notify(finished);
      return finished;
    },

    async sweep(): Promise<Job[]> {
      const lapsed = and(inArray(job.status, HELD_STATUSES), lt(job.leaseUntil, sql`now()`));
      const ended = { finishedAt: sql`now()`, leaseUntil: null, ...changed() };
      const swept: Job[] = [
        ...(await db
          .update(job)
          .set({ status: "canceled", ...ended })
          .where(and(lapsed, eq(job.cancelRequested, true)))
          .returning()),
        ...(await db
          .update(job)
          .set({ status: "failed", error: "no runner started it", ...ended })
          .where(
            and(lapsed, eq(job.status, "claimed"), sql`${job.claims} >= ${CLAIMS_BEFORE_FAILING}`),
          )
          .returning()),
        ...(await db
          .update(job)
          .set({
            status: "queued",
            runnerId: null,
            leaseUntil: null,
            claimedAt: null,
            ...changed(),
          })
          .where(and(lapsed, eq(job.status, "claimed")))
          .returning()),
        // A run that stopped reporting may have changed the target: it is never retried blindly.
        ...(await db
          .update(job)
          .set({ status: "failed", error: "the runner stopped reporting", ...ended })
          .where(and(lapsed, eq(job.status, "running")))
          .returning()),
      ];
      await reportAll(swept, notify);
      return swept;
    },

    async resync(): Promise<Job[]> {
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
      await reportAll(unreported, notify);
      return unreported;
    },

    synced: markSynced,
  };
}

export type JobQueue = ReturnType<typeof jobQueue>;
