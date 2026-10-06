import { defineConfig } from "drizzle-kit";

// TODO: until the first console release, `bun run db:push` applies the schema directly and there
// are no migrations. At that release, run `drizzle-kit generate` for the initial migration in
// drizzle 1.0's folder-per-migration format (`drizzle/<n>_<name>/migration.sql` beside its
// snapshot), apply migrations on deploy, and stop pushing.
export default defineConfig({
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
  },
});
