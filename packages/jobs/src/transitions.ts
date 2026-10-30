import { ConnectError } from "@connectrpc/connect";
import type { Job as RunnerJob } from "@console/connectors/gen/runner/v1/runner_pb";
import { db, type Executor } from "@console/db";
import { deployment, type Job, job } from "@console/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { announce, changed } from "./changes";
import { type JobDeps, nowOf } from "./deps";
import { isTerminal, moves, type RunnerView, viewOf } from "./request";
import { isActive } from "./state";

const UNREPORTED = "The job ended before ocel reported the deployment";

const OUTCOMES = { done: "succeeded", failed: "failed", canceled: "canceled" } as const;

export function messageOf(thrown: unknown): string {
  if (thrown instanceof ConnectError) return thrown.rawMessage;
  return thrown instanceof Error ? thrown.message : String(thrown);
}

export async function endDeployment(tx: Executor, ended: Job, now: Date): Promise<void> {
  if (!ended.deploymentId) return;
  const outcome =
    ended.status === "done" || ended.status === "failed" || ended.status === "canceled"
      ? OUTCOMES[ended.status]
      : "failed";
  await tx
    .update(deployment)
    .set({
      outcome,
      outcomeBy: "console",
      error: outcome === "failed" ? (ended.error ?? UNREPORTED) : null,
      deployedAt: now,
    })
    .where(
      and(
        eq(deployment.projectId, ended.projectId),
        eq(deployment.deploymentId, ended.deploymentId),
        isNull(deployment.outcome),
      ),
    );
}

export async function endJob(
  row: Job,
  status: "failed" | "canceled",
  error: string | null,
  deps: Pick<JobDeps, "notify" | "now">,
): Promise<Job | undefined> {
  const now = nowOf(deps);
  const ended = await db.transaction(async (tx) => {
    const [made] = await tx
      .update(job)
      .set({ status, error, note: null, finishedAt: now, ...changed() })
      .where(and(eq(job.id, row.id), isActive))
      .returning();
    if (made) await endDeployment(tx, made, now);
    return made;
  });
  if (ended) await announce([ended], deps.notify);
  return ended;
}

export async function recordView(
  row: Job,
  view: RunnerView,
  deps: Pick<JobDeps, "notify" | "now">,
): Promise<Job | undefined> {
  const now = nowOf(deps);
  if (!moves(row.status, view.status)) {
    if (row.unreachableSince !== null || row.acknowledgedAt === null || row.note !== null) {
      await db
        .update(job)
        .set({ unreachableSince: null, note: null, acknowledgedAt: row.acknowledgedAt ?? now })
        .where(eq(job.id, row.id));
    }
    return undefined;
  }
  const ends = isTerminal(view.status);
  const moved = await db.transaction(async (tx) => {
    const [made] = await tx
      .update(job)
      .set({
        status: view.status,
        acknowledgedAt: row.acknowledgedAt ?? now,
        unreachableSince: null,
        note: null,
        startedAt: row.startedAt ?? view.startedAt,
        ...(ends ? { finishedAt: view.endedAt ?? now, error: view.error } : {}),
        ...changed(),
      })
      .where(and(eq(job.id, row.id), eq(job.status, row.status)))
      .returning();
    if (made && ends) await endDeployment(tx, made, now);
    return made;
  });
  if (moved) await announce([moved], deps.notify);
  return moved;
}

export async function markUnreachable(row: Job, why: string, now: Date): Promise<void> {
  await db
    .update(job)
    .set({ unreachableSince: row.unreachableSince ?? now, note: why })
    .where(eq(job.id, row.id));
}

export async function noteBusy(row: Job, why: string): Promise<void> {
  await db.update(job).set({ unreachableSince: null, note: why }).where(eq(job.id, row.id));
}

export async function applyRunnerJob(
  row: Job,
  answered: RunnerJob | undefined,
  deps: Pick<JobDeps, "notify" | "now">,
): Promise<Job | undefined> {
  const view = answered && viewOf(answered);
  if (!view) {
    await markUnreachable(row, "the runner answered without the job's state", nowOf(deps));
    return undefined;
  }
  return recordView(row, view, deps);
}
