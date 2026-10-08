import { pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

export const GIT_KINDS = ["github"] as const;
export type GitKind = (typeof GIT_KINDS)[number];
export const gitKind = pgEnum("git_kind", GIT_KINDS);

export const gitApp = pgTable(
  "git_app",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    kind: gitKind("kind").notNull(),
    appId: text("app_id").notNull(),
    slug: text("slug").notNull(),
    privateKeyEnc: text("private_key_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("git_app_kind_appId_uidx").on(table.kind, table.appId)],
);

export type GitApp = typeof gitApp.$inferSelect;

export const gitInstallation = pgTable(
  "git_installation",
  {
    id: text("id").primaryKey(),
    gitAppId: text("git_app_id")
      .notNull()
      .references(() => gitApp.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    account: text("account").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("git_installation_gitAppId_externalId_uidx").on(table.gitAppId, table.externalId),
  ],
);

export type GitInstallation = typeof gitInstallation.$inferSelect;
