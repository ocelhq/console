import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async/session";
import type { Pool } from "pg";
import { migrations } from "./migrations.gen";

const MIGRATE_LOCK = 815_214;

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK]);
    try {
      await migrate(migrations, drizzle({ client }), "__drizzle_migrations");
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK]);
    }
  } finally {
    client.release();
  }
}
