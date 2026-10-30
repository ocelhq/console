import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tier } from "./deployment";
import { project } from "./project";

export const JOB_KINDS = [
  "build",
  "deploy",
  "preview-up",
  "preview-rm",
  "projects-destroy",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const jobKind = pgEnum("job_kind", JOB_KINDS);

export const JOB_STATUSES = [
  "queued",
  "running",
  "input-required",
  "done",
  "failed",
  "canceled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatus = pgEnum("job_status", JOB_STATUSES);

export const ACTIVE_JOB_STATUSES = ["queued", "running", "input-required"] as const;

export type JobSource = { sourceId: string } | { git: { cloneUrl: string; commit: string } };

export type JobSpec = {
  source: JobSource;
  git?: { commit?: string; branch?: string; dirty: boolean; pullRequest?: number };
  tag?: string;
  preview?: { name: string; persistent: boolean; label?: string };
  projectPath?: string;
  configFile?: string;
  tierValues?: true;
  provider?: string;
};

export const job = pgTable(
  "job",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: jobKind("kind").notNull(),
    tier: tier("tier").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    pr: integer("pr").notNull().default(0),
    lane: text("lane").notNull().default(""),
    sha: text("sha"),
    branch: text("branch"),
    dedupeKey: text("dedupe_key").notNull(),
    eventAt: timestamp("event_at").notNull(),
    runnerId: text("runner_id"),
    spec: jsonb("spec").$type<JobSpec>(),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    deploymentId: text("deployment_id"),
    error: text("error"),
    note: text("note"),
    runUrl: text("run_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    dispatchedAt: timestamp("dispatched_at"),
    acknowledgedAt: timestamp("acknowledged_at"),
    unreachableSince: timestamp("unreachable_since"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    revision: integer("revision").notNull().default(1),
    syncedRevision: integer("synced_revision").notNull().default(0),
    changedAt: timestamp("changed_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("job_projectId_dedupeKey_uidx").on(table.projectId, table.dedupeKey),
    uniqueIndex("job_projectId_tier_lane_dispatched_uidx")
      .on(table.projectId, table.tier, table.lane)
      .where(
        sql`${table.dispatchedAt} is not null and ${table.status} in ('queued', 'running', 'input-required')`,
      ),
    index("job_status_createdAt_idx").on(table.status, table.createdAt),
    index("job_projectId_pr_idx").on(table.projectId, table.pr, table.createdAt),
    index("job_unsynced_idx")
      .on(table.changedAt)
      .where(sql`${table.revision} <> ${table.syncedRevision}`),
  ],
);

export type Job = typeof job.$inferSelect;
