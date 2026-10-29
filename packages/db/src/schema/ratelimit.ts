import { doublePrecision, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const rateLimitBucket = pgTable(
  "rate_limit_bucket",
  {
    key: text("key").primaryKey(),
    tokens: doublePrecision("tokens").notNull(),
    refilledAt: timestamp("refilled_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("rate_limit_bucket_refilled_at_idx").on(table.refilledAt)],
);
