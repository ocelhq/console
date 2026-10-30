import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { type Framework, project } from "./project";

export const DEPLOYMENT_KINDS = ["deploy", "preview-up", "rollback"] as const;
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number];
export const deploymentKind = pgEnum("deployment_kind", DEPLOYMENT_KINDS);

export const DEPLOYMENT_OUTCOMES = ["succeeded", "failed", "canceled"] as const;
export type DeploymentOutcome = (typeof DEPLOYMENT_OUTCOMES)[number];
export const deploymentOutcome = pgEnum("deployment_outcome", DEPLOYMENT_OUTCOMES);

export const OUTCOME_WRITERS = ["ocel", "console"] as const;
export type OutcomeWriter = (typeof OUTCOME_WRITERS)[number];
export const outcomeWriter = pgEnum("outcome_writer", OUTCOME_WRITERS);

export const TIERS = ["production", "preview"] as const;
export type Tier = (typeof TIERS)[number];
export const tier = pgEnum("tier", TIERS);

export const TRIGGER_KINDS = ["cli", "ci", "git", "console"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const VARIABLE_CLASSES = ["plain", "sensitive", "secret", "derived"] as const;
export type VariableClass = (typeof VARIABLE_CLASSES)[number];

export const RESOURCE_TYPES = [
  "postgres",
  "bucket",
  "topic",
  "task",
  "kv",
  "realtime",
  "custom",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const COMPUTE_KINDS = ["serverless", "container"] as const;
export type ComputeKind = (typeof COMPUTE_KINDS)[number];
export const computeKind = pgEnum("compute_kind", COMPUTE_KINDS);

export const APP_OUTCOMES = ["succeeded", "failed", "skipped"] as const;
export type AppOutcome = (typeof APP_OUTCOMES)[number];

export const STAGE_STATUSES = ["succeeded", "failed", "skipped"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export type DeploymentCi = { provider: string; repo?: string; url?: string; pr?: number };

export type DeploymentTrigger = {
  kind: TriggerKind;
  actor?: string;
  ci?: DeploymentCi;
  remote?: { runner: string };
};

export type Principal =
  | { kind: "session"; userId: string }
  | { kind: "pipeline"; pipelineId: string; jti: string }
  | { kind: "job"; jobId: string };

export type DeploymentGit = {
  sha?: string;
  branch?: string;
  message?: string;
  author?: string;
  dirty: boolean;
};

export type DeploymentStage = {
  name: string;
  app?: string;
  startedAt: string;
  finishedAt: string;
  status: StageStatus;
  error?: string;
  log: string[];
};

export type DeploymentVariable = {
  key: string;
  class: VariableClass;
  folder?: string;
  description?: string;
  group?: string;
  required?: boolean;
};

export type DeploymentVariableGroup = {
  key: string;
  required: boolean;
  description?: string;
};

export type DeploymentApp = {
  name: string;
  folder?: string;
  runtime?: { name: string; arch?: string };
  framework?: Framework;
  compute: ComputeKind;
  release?: string;
  buildId?: string;
  urls: string[];
  hostnames: string[];
  healthPath?: string;
  outcome: AppOutcome;
  error?: string;
  variables: DeploymentVariable[];
};

export type DeploymentGrant = { verb?: string; actions: string[] };

export type DeploymentBinding = {
  name: string;
  source?: string;
  propertyKeys: string[];
  grants: DeploymentGrant[];
};

export type DeploymentResource = { name: string; type: ResourceType; binding: DeploymentBinding };

export type DeploymentUsage = { app: string; resource: string; files: string[] };

export type DeploymentTopology = {
  apps: DeploymentApp[];
  resources: DeploymentResource[];
  usages: DeploymentUsage[];
  variableGroups?: DeploymentVariableGroup[];
};

type Stamped = {
  deployedAt: AnyPgColumn;
  startedAt: AnyPgColumn;
  createdAt: AnyPgColumn;
};

const atOf = (table: Stamped) =>
  sql<Date>`coalesce(${table.deployedAt}, ${table.startedAt}, ${table.createdAt})`;

export const deployment = pgTable(
  "deployment",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id").notNull(),
    kind: deploymentKind("kind").notNull(),
    tier: tier("tier").notNull(),
    environmentIdentity: text("environment_identity").notNull().default(""),
    promotionId: text("promotion_id"),
    tag: text("tag"),
    providerName: text("provider_name").notNull().default(""),
    providerRegion: text("provider_region"),
    target: text("target").notNull().default(""),
    edgeKind: text("edge_kind"),
    outcome: deploymentOutcome("outcome"),
    outcomeBy: outcomeWriter("outcome_by"),
    error: text("error"),
    trigger: jsonb("trigger").$type<DeploymentTrigger>().notNull(),
    principal: jsonb("principal").$type<Principal>(),
    git: jsonb("git").$type<DeploymentGit>(),
    cliVersion: text("cli_version"),
    startedAt: timestamp("started_at"),
    deployedAt: timestamp("deployed_at"),
    jobId: text("job_id"),
    runnerId: text("runner_id"),
    trace: jsonb("trace").$type<DeploymentStage[]>().notNull().default([]),
    topology: jsonb("topology")
      .$type<DeploymentTopology>()
      .notNull()
      .default({ apps: [], resources: [], usages: [] }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("deployment_deployment_id_uidx").on(table.projectId, table.deploymentId),
    index("deployment_project_latest_idx").on(table.projectId, table.tier, table.deployedAt),
    index("deployment_project_at_idx").on(table.projectId, atOf(table)),
    check(
      "deployment_ended_at_once",
      sql`(${table.outcome} is null) = (${table.deployedAt} is null)`,
    ),
    check(
      "deployment_outcome_has_writer",
      sql`(${table.outcome} is null) = (${table.outcomeBy} is null)`,
    ),
  ],
);

export type Deployment = typeof deployment.$inferSelect;

export const deploymentAt = atOf(deployment);

export const ENVIRONMENT_EVENT_KINDS = ["preview-removed", "destroyed"] as const;
export type EnvironmentEventKind = (typeof ENVIRONMENT_EVENT_KINDS)[number];
export const environmentEventKind = pgEnum("environment_event_kind", ENVIRONMENT_EVENT_KINDS);

export const environmentEvent = pgTable(
  "environment_event",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id").notNull(),
    kind: environmentEventKind("kind").notNull(),
    tier: tier("tier").notNull(),
    environmentIdentity: text("environment_identity").notNull().default(""),
    occurredAt: timestamp("occurred_at").notNull(),
    git: jsonb("git").$type<DeploymentGit>(),
    ci: jsonb("ci").$type<DeploymentCi>(),
    principal: jsonb("principal").$type<Principal>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("environment_event_deployment_id_uidx").on(table.projectId, table.deploymentId),
    index("environment_event_project_idx").on(table.projectId, table.occurredAt),
  ],
);

export type EnvironmentEvent = typeof environmentEvent.$inferSelect;
