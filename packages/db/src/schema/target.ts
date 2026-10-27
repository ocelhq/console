import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { tier } from "./deployment";
import { project } from "./project";

export const VENDORS = ["aws", "gcp"] as const;
export type Vendor = (typeof VENDORS)[number];

export const target = pgTable(
  "target",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    vendor: text("vendor").$type<Vendor>().notNull(),
    account: text("account").notNull(),
    region: text("region").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("target_organizationId_vendor_account_region_uidx").on(
      table.organizationId,
      table.vendor,
      table.account,
      table.region,
    ),
  ],
);

export type Target = typeof target.$inferSelect;

export const targetTier = pgTable(
  "target_tier",
  {
    targetId: uuid("target_id")
      .notNull()
      .references(() => target.id, { onDelete: "cascade" }),
    tier: tier("tier").notNull(),
    identityProvider: text("identity_provider").notNull(),
    principal: text("principal").notNull(),
    grants: text("grants").array().notNull(),
    cliVersion: text("cli_version").notNull(),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
    lastIssuedAt: timestamp("last_issued_at"),
  },
  (table) => [primaryKey({ columns: [table.targetId, table.tier] })],
);

export type TargetTier = typeof targetTier.$inferSelect;

export const targetBinding = pgTable(
  "target_binding",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    tier: tier("tier").notNull(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => target.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.tier] }),
    index("target_binding_targetId_idx").on(table.targetId),
  ],
);

export const ISSUANCE_PURPOSES = ["deploy", "test"] as const;
export type IssuancePurpose = (typeof ISSUANCE_PURPOSES)[number];
export const issuancePurpose = pgEnum("issuance_purpose", ISSUANCE_PURPOSES);

export type IssuancePrincipal =
  | { kind: "pipeline"; pipelineId: string; jti: string; runUrl: string }
  | { kind: "session"; userId: string };

export const credentialIssuance = pgTable(
  "credential_issuance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    targetId: uuid("target_id").notNull(),
    tier: tier("tier").notNull(),
    purpose: issuancePurpose("purpose").notNull().default("deploy"),
    principal: jsonb("principal").$type<IssuancePrincipal>().notNull(),
    tokenJti: text("token_jti").notNull(),
    issuedAt: timestamp("issued_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("credential_issuance_tokenJti_uidx").on(table.tokenJti),
    index("credential_issuance_organizationId_issuedAt_idx").on(
      table.organizationId,
      table.issuedAt,
    ),
    index("credential_issuance_projectId_issuedAt_idx").on(table.projectId, table.issuedAt),
  ],
);

export type CredentialIssuance = typeof credentialIssuance.$inferSelect;
