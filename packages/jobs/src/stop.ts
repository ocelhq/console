import type { Role } from "@console/connectors";
import type { Transaction } from "@console/db";
import { type Job, job } from "@console/db/schema";
import { and, eq, type SQL } from "drizzle-orm";
import { announce, changed } from "./changes";
import type { JobDeps } from "./deps";
import { cancelJob } from "./send";
import { isHeld, isReleased, phaseOf } from "./state";
import { endDeployment } from "./transitions";

export async function stopJobs(tx: Transaction, where: SQL | undefined, now: Date): Promise<Job[]> {
  const canceled = await tx
    .update(job)
    .set({ status: "canceled", finishedAt: now, ...changed() })
    .where(and(where, isHeld))
    .returning();
  for (const row of canceled) await endDeployment(tx, row, now);
  const canceling = await tx
    .update(job)
    .set({ cancelRequested: true, ...changed() })
    .where(and(where, isReleased, eq(job.cancelRequested, false)))
    .returning();
  return [...canceled, ...canceling];
}

export async function followCancels(
  stopped: readonly Job[],
  deps: JobDeps,
  role?: Role,
): Promise<void> {
  await announce(stopped, deps.notify);
  for (const row of stopped) {
    if (phaseOf(row) !== "ended") await cancelJob(row, deps, role);
  }
}
