import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async/session";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate";
import { migrations } from "./migrations.gen";

describe("migrations.gen.ts", () => {
  it("matches drizzle/, so run `bun run db:generate` after changing the schema", () => {
    expect(migrations).toEqual(readMigrationFiles({ migrationsFolder: "drizzle" }));
  });
});

describe("migrateDatabase", () => {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ocelhq_test",
  );
  const database = `migrate_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: new URL("/postgres", url).toString() });
  let pool: Pool;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    pool = new Pool({ connectionString: new URL(`/${database}`, url).toString() });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  });

  it("creates every table in an empty database, and concurrent runs apply each migration once", async () => {
    await Promise.all([migrateDatabase(pool), migrateDatabase(pool), migrateDatabase(pool)]);

    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(["user", "session", "organization", "invitation", "connector"]),
    );
    const applied = await pool.query("select hash from drizzle.__drizzle_migrations");
    expect(applied.rowCount).toBe(migrations.length);
  });

  it("keeps a deployment's id and each app's release when the deployment vocabulary changes", async () => {
    const before = `${database}_vocabulary`;
    await admin.query(`CREATE DATABASE "${before}"`);
    const old = new Pool({ connectionString: new URL(`/${before}`, url).toString() });
    try {
      const earlier = migrations.filter(
        (migration) => !migration.name.endsWith("_tier_deployment_id_release"),
      );
      await migrate(earlier, drizzle({ client: old }), "__drizzle_migrations");
      await old.query(
        `insert into "organization" (id, name, slug, created_at) values ('org', 'Org', 'org', now());
         insert into "project" (id, organization_id, name, slug) values ('p', 'org', 'Shop', 'shop');
         insert into "deployment" (id, project_id, run_id, kind, environment_class, provider_name,
           target, outcome, trigger, deployed_at, trace, topology)
           values ('d', 'p', 'trace-1', 'deploy', 'production', 'aws', 't', 'succeeded',
             '{"kind":"cli"}', now(), '[]',
             '{"apps":[{"name":"web","deploymentId":"rel-1"},{"name":"api"}],"resources":[],"usages":[]}');`,
      );

      await migrateDatabase(old);

      const deployment = await old.query<{ deployment_id: string; tier: string; apps: unknown }>(
        `select deployment_id, tier::text, topology->'apps' as apps from "deployment" where id = 'd'`,
      );
      expect(deployment.rows[0]).toEqual({
        deployment_id: "trace-1",
        tier: "production",
        apps: [{ name: "web", release: "rel-1" }, { name: "api" }],
      });
    } finally {
      await old.end();
      await admin.query(`DROP DATABASE "${before}"`);
    }
  });

  it("keeps a project that chose Next.js as one that chose next", async () => {
    const before = `${database}_framework`;
    await admin.query(`CREATE DATABASE "${before}"`);
    const old = new Pool({ connectionString: new URL(`/${before}`, url).toString() });
    try {
      const initial = migrations.filter((migration) => migration.name.endsWith("_initial"));
      await migrate(initial, drizzle({ client: old }), "__drizzle_migrations");
      await old.query(
        `insert into "organization" (id, name, slug, created_at) values ('org', 'Org', 'org', now());
         insert into "project" (id, organization_id, name, slug, frameworks)
           values ('p', 'org', 'Shop', 'shop', '{nextjs,go}');`,
      );

      await migrateDatabase(old);

      const project = await old.query<{ frameworks: string }>(
        `select frameworks::text from "project" where id = 'p'`,
      );
      expect(project.rows[0]?.frameworks).toBe("{next,go}");
    } finally {
      await old.end();
      await admin.query(`DROP DATABASE "${before}"`);
    }
  });
});
