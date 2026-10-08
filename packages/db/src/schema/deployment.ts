import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { type Framework, project } from "./project";

export const DEPLOYMENT_KINDS = ["deploy", "preview-up", "rollback"] as const;
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number];
export const deploymentKind = pgEnum("deployment_kind", DEPLOYMENT_KINDS);

export const DEPLOYMENT_OUTCOMES = ["succeeded", "failed"] as const;
export type DeploymentOutcome = (typeof DEPLOYMENT_OUTCOMES)[number];
export const deploymentOutcome = pgEnum("deployment_outcome", DEPLOYMENT_OUTCOMES);

export const TIERS = ["production", "preview"] as const;
export type Tier = (typeof TIERS)[number];
export const tier = pgEnum("tier", TIERS);

export const TRIGGER_KINDS = ["cli", "ci", "git"] as const;
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
};

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
    providerName: text("provider_name").notNull(),
    providerRegion: text("provider_region"),
    target: text("target").notNull(),
    edgeKind: text("edge_kind"),
    outcome: deploymentOutcome("outcome").notNull(),
    error: text("error"),
    trigger: jsonb("trigger").$type<DeploymentTrigger>().notNull(),
    git: jsonb("git").$type<DeploymentGit>(),
    cliVersion: text("cli_version"),
    startedAt: timestamp("started_at"),
    deployedAt: timestamp("deployed_at").notNull(),
    trace: jsonb("trace").$type<DeploymentStage[]>().notNull(),
    topology: jsonb("topology").$type<DeploymentTopology>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("deployment_deployment_id_uidx").on(table.projectId, table.deploymentId),
    index("deployment_project_latest_idx").on(table.projectId, table.tier, table.deployedAt),
  ],
);

export type Deployment = typeof deployment.$inferSelect;

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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("environment_event_deployment_id_uidx").on(table.projectId, table.deploymentId),
    index("environment_event_project_idx").on(table.projectId, table.occurredAt),
  ],
);

export type EnvironmentEvent = typeof environmentEvent.$inferSelect;
