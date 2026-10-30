import { Code, ConnectError } from "@connectrpc/connect";
import { db } from "@console/db";
import { type Job, job, project } from "@console/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { type JobDeps, nowOf } from "./deps";
import type { RunnerView } from "./request";
import { cancelJob, jobAt, sendJob } from "./send";
import { type DispatchedJob, dispatched, isHeld, isReleased, phaseOf } from "./state";
import { JOB_GRACE_SECONDS, JOB_TIMEOUT_SECONDS } from "./token";
import { applyRunnerJob, endJob, markUnreachable, messageOf, recordView } from "./transitions";

export const UNREACHABLE_BOUND_MS = 10 * 60_000;

const JOB_TIMEOUT_MS = JOB_TIMEOUT_SECONDS * 1000;

const RUN_BOUND_MS = (JOB_TIMEOUT_SECONDS + JOB_GRACE_SECONDS) * 1000;

const since = (at: Date | null, now: Date) => (at ? now.getTime() - at.getTime() : 0);

async function resend(row: DispatchedJob, deps: JobDeps, now: Date) {
  if (since(row.unreachableSince, now) > UNREACHABLE_BOUND_MS) {
    return row.cancelRequested
      ? endJob(row, "canceled", null, deps)
      : endJob(row, "failed", `The runner did not take the job: ${row.note ?? ""}`, deps);
  }
  if (since(row.dispatchedAt, now) > JOB_TIMEOUT_MS) {
    return endJob(row, "failed", "The runner had no room for the job before it timed out", deps);
  }
  return row.cancelRequested ? cancelJob(row, deps) : sendJob(row.id, deps);
}

async function follow(row: DispatchedJob, organizationId: string, deps: JobDeps, now: Date) {
  if (since(row.acknowledgedAt, now) > RUN_BOUND_MS) {
    return endJob(
      row,
      "failed",
      "The job outlived its time limit and its runner never ended it",
      deps,
    );
  }
  if (row.cancelRequested) return cancelJob(row, deps);
  try {
    return await applyRunnerJob(row, await deps.runners.get(jobAt(row, organizationId)), deps);
  } catch (thrown) {
    const lost = thrown instanceof ConnectError && thrown.code === Code.NotFound;
    const why = lost ? "The runner no longer knows the job" : messageOf(thrown);
    if (since(row.unreachableSince ?? now, now) > UNREACHABLE_BOUND_MS) {
      return endJob(row, "failed", why, deps);
    }
    await markUnreachable(row, why, now);
    return undefined;
  }
}

async function byRunner<T extends { runnerId: string | null }>(
  rows: readonly T[],
  each: (row: T) => Promise<unknown>,
): Promise<void> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.runnerId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  await Promise.allSettled(
    [...groups.values()].map(async (group) => {
      for (const row of group) {
        await each(row).catch((error: unknown) => {
          console.error("jobs: the sweep failed on a job", { error });
        });
      }
    }),
  );
}

function followed(row: Job, organizationId: string, deps: JobDeps, now: Date) {
  const sent = dispatched(row);
  return phaseOf(sent) === "sending"
    ? resend(sent, deps, now)
    : follow(sent, organizationId, deps, now);
}

async function releaseNext(row: Job, deps: JobDeps): Promise<void> {
  const [next] = await db
    .select({ id: job.id })
    .from(job)
    .where(
      and(eq(job.projectId, row.projectId), eq(job.tier, row.tier), eq(job.lane, row.lane), isHeld),
    )
    .orderBy(asc(job.createdAt), asc(job.id))
    .limit(1);
  if (next) await sendJob(next.id, deps);
}

export async function followJob(
  jobId: string,
  deps: JobDeps,
  heard: "started" | "reported",
): Promise<void> {
  const now = nowOf(deps);
  const [found] = await db
    .select({ row: job, organizationId: project.organizationId })
    .from(job)
    .innerJoin(project, eq(project.id, job.projectId))
    .where(eq(job.id, jobId));
  if (!found || phaseOf(found.row) === "held") return;
  let row = found.row;
  if (heard === "started" && phaseOf(row) !== "ended") {
    row = (await recordView(row, ran(now), deps)) ?? row;
  }
  if (phaseOf(row) !== "ended") await followed(row, found.organizationId, deps, now);
  const [latest] = await db.select().from(job).where(eq(job.id, jobId));
  if (latest && phaseOf(latest) === "ended") await releaseNext(latest, deps);
}

const ran = (now: Date): RunnerView => ({
  status: "running",
  startedAt: now,
  endedAt: null,
  error: null,
});

export async function sweepJobs(deps: JobDeps): Promise<void> {
  const now = nowOf(deps);
  const released = await db
    .select({ row: job, runnerId: job.runnerId, organizationId: project.organizationId })
    .from(job)
    .innerJoin(project, eq(project.id, job.projectId))
    .where(isReleased);
  await byRunner(released, ({ row, organizationId }) => followed(row, organizationId, deps, now));

  const held = await db
    .select({ id: job.id, runnerId: job.runnerId })
    .from(job)
    .where(isHeld)
    .orderBy(asc(job.createdAt), asc(job.id));
  await byRunner(held, ({ id }) => sendJob(id, deps));
}
