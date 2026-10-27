import { index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import type { Tier } from "./deployment";
import { project } from "./project";

export const PIPELINE_KINDS = ["github-actions"] as const;
export type PipelineKind = (typeof PIPELINE_KINDS)[number];
export const pipelineKind = pgEnum("pipeline_kind", PIPELINE_KINDS);

export const PIPELINE_ORIGINS = ["linked", "manual"] as const;
export type PipelineOrigin = (typeof PIPELINE_ORIGINS)[number];
export const pipelineOrigin = pgEnum("pipeline_origin", PIPELINE_ORIGINS);

export type CredentialGrant = Partial<Record<Tier, { branches: string[]; environment?: string }>>;

export const trustedPipeline = pgTable(
  "trusted_pipeline",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: pipelineKind("kind").notNull(),
    repository: text("repository").notNull(),
    repositoryId: text("repository_id"),
    repositoryOwnerId: text("repository_owner_id"),
    workflow: text("workflow"),
    environment: text("environment"),
    branches: text("branches").array().notNull().default(["*"]),
    credentials: jsonb("credentials").$type<CredentialGrant>().notNull().default({}),
    origin: pipelineOrigin("origin").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at"),
  },
  (table) => [index("trusted_pipeline_projectId_idx").on(table.projectId)],
);

export type TrustedPipeline = typeof trustedPipeline.$inferSelect;

export const pipelineToken = pgTable(
  "pipeline_token",
  {
    issuer: text("issuer").notNull(),
    jti: text("jti").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.jti] }),
    index("pipeline_token_expiresAt_idx").on(table.expiresAt),
  ],
);
