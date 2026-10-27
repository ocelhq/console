import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/pg-core/async/session";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase } from "./testing";

const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
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
      const earlier = migrations.slice(
        0,
        migrations.findIndex((migration) => migration.name.endsWith("_tier_deployment_id_release")),
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

  it("grants the linked pipelines that predate credential grants what a new linked pipeline gets", async () => {
    const before = `${database}_grants`;
    await admin.query(`CREATE DATABASE "${before}"`);
    const old = new Pool({ connectionString: new URL(`/${before}`, url).toString() });
    try {
      const earlier = migrations.slice(
        0,
        migrations.findIndex((migration) =>
          migration.name.endsWith("_linked_pipeline_credentials"),
        ),
      );
      await migrate(earlier, drizzle({ client: old }), "__drizzle_migrations");
      await old.query(
        `insert into "organization" (id, name, slug, created_at) values ('org', 'Org', 'org', now());
         insert into "project" (id, organization_id, name, slug) values ('p', 'org', 'Shop', 'shop');
         insert into "git_app" (id, organization_id, kind, app_id, slug, private_key_enc,
           webhook_secret_enc, client_id, client_secret_enc)
           values ('a', 'org', 'github', '1', 'app', 'k', 'w', 'c', 's');
         insert into "git_installation" (id, git_app_id, organization_id, external_id, account)
           values ('i', 'a', 'org', '9', 'acme');
         insert into "project_repo" (project_id, installation_id, repo_id, repo_owner_id,
           full_name, production_branch, deploys)
           values ('p', 'i', '77', '42', 'acme/shop', 'trunk', 'ci');
         insert into "trusted_pipeline" (id, project_id, kind, repository, origin)
           values ('linked', 'p', 'github-actions', 'acme/shop', 'linked'),
                  ('manual', 'p', 'github-actions', 'acme/shop', 'manual');`,
      );

      await migrateDatabase(old);

      const granted = await old.query<{ id: string; credentials: unknown }>(
        `select id, credentials from "trusted_pipeline" order by id`,
      );
      expect(granted.rows).toEqual([
        {
          id: "linked",
          credentials: { production: { branches: ["trunk"] }, preview: { branches: ["*"] } },
        },
        { id: "manual", credentials: {} },
      ]);
    } finally {
      await old.end();
      await admin.query(`DROP DATABASE "${before}"`);
    }
  });

  it('lets `bun run db:migrate` migrate the database postgres("main") binds, as lifecycle.preBuild does', async () => {
    const target = `${database}_prebuild`;
    await admin.query(`CREATE DATABASE "${target}"`);
    const bound = new Pool({ connectionString: new URL(`/${target}`, url).toString() });
    try {
      const { DATABASE_URL: _, ...env } = process.env;
      execFileSync("bun", ["run", "db:migrate"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...env,
          OCEL_RESOURCE_POSTGRES_main: JSON.stringify({
            name: "main",
            postgres: {
              host: url.hostname,
              port: Number(url.port || 5432),
              database: target,
              username: decodeURIComponent(url.username),
              password: decodeURIComponent(url.password),
            },
          }),
        },
        stdio: "pipe",
      });

      const tables = await bound.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        expect.arrayContaining(["user", "session", "organization", "invitation", "connector"]),
      );
      const applied = await bound.query("select hash from drizzle.__drizzle_migrations");
      expect(applied.rowCount).toBe(migrations.length);

      await migrateDatabase(bound);
      const reapplied = await bound.query("select hash from drizzle.__drizzle_migrations");
      expect(reapplied.rowCount).toBe(migrations.length);
    } finally {
      await bound.end();
      await admin.query(`DROP DATABASE "${target}"`);
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
