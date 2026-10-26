import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async/session";
import { Pool } from "pg";

const MIGRATE_LOCK = 815_214;

export async function migrateDatabase(pool: Pool): Promise<void> {
  const migrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
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

const DATABASE_EXISTS_CODES = new Set(["42P04", "23505"]);

async function ensureDatabaseExists(connectionString: string) {
  const url = new URL(connectionString);
  const dbName = url.pathname.slice(1);
  url.pathname = "/postgres";

  const adminPool = new Pool({ connectionString: url.toString() });
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } catch (error) {
    if (!DATABASE_EXISTS_CODES.has((error as { code?: string }).code ?? "")) {
      throw error;
    }
  } finally {
    await adminPool.end();
  }
}

let setupPromise: Promise<void> | undefined;

export function setupTestDatabase() {
  if (!setupPromise) {
    setupPromise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error(
          "DATABASE_URL must be set (vitest.config.ts routes it to TEST_DATABASE_URL) to run tests against a real Postgres instance",
        );
      }

      await ensureDatabaseExists(connectionString);

      const pool = new Pool({ connectionString });
      try {
        await migrateDatabase(pool);
      } finally {
        await pool.end();
      }
    })();
  }

  return setupPromise;
}
