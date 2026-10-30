import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { computeKind, tier } from "./deployment";
import { project } from "./project";

export const ENDPOINT_REACHES = ["dial"] as const;
export type EndpointReach = (typeof ENDPOINT_REACHES)[number];
export const endpointReach = pgEnum("endpoint_reach", ENDPOINT_REACHES);

export type EndpointDenial = { verb: string; at: string; message: string };

export const endpoint = pgTable(
  "endpoint",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    target: text("target"),
    vendor: text("vendor").notNull(),
    compute: computeKind("compute"),
    reach: endpointReach("reach").notNull().default("dial"),
    url: text("url"),
    publicKey: text("public_key"),
    tlsPin: text("tls_pin"),
    version: text("version"),
    services: jsonb("services").$type<string[]>().notNull().default([]),
    allowedScopes: jsonb("allowed_scopes").$type<string[]>().notNull().default([]),
    connectedAt: timestamp("connected_at"),
    lastSeenAt: timestamp("last_seen_at"),
    lastDenied: jsonb("last_denied").$type<EndpointDenial>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("endpoint_organizationId_name_uidx").on(table.organizationId, table.name),
    uniqueIndex("endpoint_organizationId_target_uidx").on(table.organizationId, table.target),
  ],
);

export type Endpoint = typeof endpoint.$inferSelect;

export const RUNNER_KINDS = ["ocel-cloud", "endpoint"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];
export const runnerKind = pgEnum("runner_kind", RUNNER_KINDS);

export const runnerBinding = pgTable(
  "runner_binding",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    tier: tier("tier").notNull(),
    runner: runnerKind("runner").notNull(),
    endpointId: text("endpoint_id").references(() => endpoint.id, { onDelete: "cascade" }),
    credentials: boolean("credentials").notNull().default(false),
    boundAt: timestamp("bound_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.tier] }),
    index("runner_binding_endpointId_idx").on(table.endpointId),
    check(
      "runner_binding_endpoint_named",
      sql`(${table.runner} = 'endpoint') = (${table.endpointId} is not null)`,
    ),
  ],
);

export type RunnerBinding = typeof runnerBinding.$inferSelect;
