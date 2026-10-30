import { ACTIVE_JOB_STATUSES, type Job, job } from "@console/db/schema";
import { and, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { isTerminal } from "./request";

export type Phase = "held" | "sending" | "following" | "ended";

export function phaseOf(row: Pick<Job, "status" | "dispatchedAt" | "acknowledgedAt">): Phase {
  if (isTerminal(row.status)) return "ended";
  if (row.dispatchedAt === null) return "held";
  return row.acknowledgedAt === null ? "sending" : "following";
}

export const isActive: SQL = inArray(job.status, [...ACTIVE_JOB_STATUSES]);

export const isHeld = and(eq(job.status, "queued"), isNull(job.dispatchedAt)) as SQL;

export const isReleased = and(isActive, isNotNull(job.dispatchedAt)) as SQL;

export type DispatchedJob = Job & { runnerId: string; dispatchedAt: Date };

export function dispatched(row: Job): DispatchedJob {
  if (row.runnerId === null || row.dispatchedAt === null) {
    throw new Error(`job ${row.id} was never dispatched to a runner`);
  }
  return { ...row, runnerId: row.runnerId, dispatchedAt: row.dispatchedAt };
}

export const isFromGit: SQL = sql`${job.spec}->'source' ? 'git'`;

export const isFromRepository: SQL = sql`not coalesce(${job.spec}->'source' ? 'sourceId', false)`;
