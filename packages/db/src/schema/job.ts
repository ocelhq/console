import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { project } from "./project";

export const RUNNER_KINDS = ["managed", "self-hosted"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];
export const runnerKind = pgEnum("runner_kind", RUNNER_KINDS);

export const runner = pgTable(
  "runner",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    kind: runnerKind("kind").notNull(),
    name: text("name").notNull(),
    labels: text("labels").array().notNull().default([]),
    publicKey: text("public_key").notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("runner_organizationId_idx").on(table.organizationId),
    check(
      "runner_managed_has_no_organization",
      sql`(${table.kind} = 'managed') = (${table.organizationId} is null)`,
    ),
  ],
);

export type Runner = typeof runner.$inferSelect;

export const JOB_KINDS = ["deploy", "preview-up", "preview-rm"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const jobKind = pgEnum("job_kind", JOB_KINDS);

export const JOB_STATUSES = ["queued", "claimed", "running", "done", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatus = pgEnum("job_status", JOB_STATUSES);

export const job = pgTable(
  "job",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: jobKind("kind").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    pr: integer("pr").notNull().default(0),
    sha: text("sha"),
    branch: text("branch"),
    labels: text("labels").array().notNull().default([]),
    dedupeKey: text("dedupe_key").notNull(),
    eventAt: timestamp("event_at").notNull(),
    runnerId: text("runner_id").references(() => runner.id, { onDelete: "set null" }),
    leaseUntil: timestamp("lease_until"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    claims: integer("claims").notNull().default(0),
    deploymentId: text("deployment_id"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    claimedAt: timestamp("claimed_at"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    revision: integer("revision").notNull().default(1),
    syncedRevision: integer("synced_revision").notNull().default(0),
    changedAt: timestamp("changed_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("job_projectId_dedupeKey_uidx").on(table.projectId, table.dedupeKey),
    uniqueIndex("job_projectId_pr_held_uidx")
      .on(table.projectId, table.pr)
      .where(sql`${table.status} in ('claimed', 'running')`),
    index("job_status_createdAt_idx").on(table.status, table.createdAt),
    index("job_projectId_pr_idx").on(table.projectId, table.pr, table.createdAt),
    index("job_unsynced_idx")
      .on(table.changedAt)
      .where(sql`${table.revision} <> ${table.syncedRevision}`),
  ],
);

export type Job = typeof job.$inferSelect;
