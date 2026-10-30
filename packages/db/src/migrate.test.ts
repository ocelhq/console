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
      expect.arrayContaining(["user", "session", "organization", "invitation", "endpoint"]),
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

  it("keeps the history of jobs from before runners, and fails the ones the console never ran", async () => {
    const before = `${database}_jobs`;
    await admin.query(`CREATE DATABASE "${before}"`);
    const old = new Pool({ connectionString: new URL(`/${before}`, url).toString() });
    try {
      const earlier = migrations.slice(
        0,
        migrations.findIndex((migration) => migration.name.endsWith("_jobs_tiered")),
      );
      await migrate(earlier, drizzle({ client: old }), "__drizzle_migrations");
      await old.query(
        `insert into "organization" (id, name, slug, created_at) values ('org', 'Org', 'org', now());
         insert into "project" (id, organization_id, name, slug) values ('p', 'org', 'Shop', 'shop');
         insert into "job" (id, project_id, kind, status, pr, dedupe_key, event_at, finished_at, error, revision, synced_revision)
           values ('queued', 'p', 'deploy', 'queued', 0, 'd1', now(), null, null, 1, 1),
                  ('claimed', 'p', 'preview-up', 'claimed', 7, 'd2', now(), null, null, 1, 1),
                  ('running', 'p', 'preview-rm', 'running', 9, 'd3', now(), null, 'kept', 2, 2),
                  ('reported', 'p', 'deploy', 'done', 0, 'report:a', now(), '2026-01-02', null, 1, 1),
                  ('broke', 'p', 'preview-up', 'failed', 8, 'report:b', now(), '2026-01-03', 'it broke', 1, 1);
         insert into "deployment" (id, project_id, deployment_id, kind, tier, provider_name, target,
           outcome, trigger, deployed_at, trace, topology)
           values ('d', 'p', 'a', 'deploy', 'production', 'aws', 't', 'succeeded', '{"kind":"ci"}',
             now(), '[]', '{"apps":[],"resources":[],"usages":[]}');`,
      );

      await migrateDatabase(old);

      const jobs = await old.query<{
        id: string;
        tier: string;
        status: string;
        error: string | null;
        ended: boolean;
        unsynced: boolean;
      }>(
        `select id, tier::text, status::text, error, finished_at is not null as ended,
           revision <> synced_revision as unsynced
         from "job" order by id`,
      );
      const stopped = "the console stopped claiming jobs before this one ran";
      expect(jobs.rows).toEqual([
        {
          id: "broke",
          tier: "preview",
          status: "failed",
          error: "it broke",
          ended: true,
          unsynced: false,
        },
        {
          id: "claimed",
          tier: "preview",
          status: "failed",
          error: stopped,
          ended: true,
          unsynced: true,
        },
        {
          id: "queued",
          tier: "production",
          status: "failed",
          error: stopped,
          ended: true,
          unsynced: true,
        },
        {
          id: "reported",
          tier: "production",
          status: "done",
          error: null,
          ended: true,
          unsynced: false,
        },
        {
          id: "running",
          tier: "preview",
          status: "failed",
          error: "kept",
          ended: true,
          unsynced: true,
        },
      ]);
      const deployment = await old.query<{ outcome_by: string }>(
        `select outcome_by::text from "deployment" where id = 'd'`,
      );
      expect(deployment.rows).toEqual([{ outcome_by: "ocel" }]);
    } finally {
      await old.end();
      await admin.query(`DROP DATABASE "${before}"`);
    }
  });

  it("names each preview job's lane after its preview", async () => {
    const before = `${database}_lanes`;
    await admin.query(`CREATE DATABASE "${before}"`);
    const old = new Pool({ connectionString: new URL(`/${before}`, url).toString() });
    try {
      const earlier = migrations.slice(
        0,
        migrations.findIndex((migration) => migration.name.endsWith("_job_lanes")),
      );
      await migrate(earlier, drizzle({ client: old }), "__drizzle_migrations");
      await old.query(
        `insert into "organization" (id, name, slug, created_at) values ('org', 'Org', 'org', now());
         insert into "project" (id, organization_id, name, slug) values ('p', 'org', 'Shop', 'shop');
         insert into "deployment" (id, project_id, deployment_id, kind, tier, environment_identity,
           provider_name, target, outcome, outcome_by, trigger, deployed_at)
           values ('d', 'p', 'ci-dep', 'preview-up', 'preview', 'feature-x', 'aws', 't',
             'succeeded', 'ocel', '{"kind":"ci"}', now());
         insert into "job" (id, project_id, kind, tier, status, pr, dedupe_key, event_at, spec, deployment_id)
           values ('cli', 'p', 'preview-up', 'preview', 'done', 0, 'a', now(),
                   '{"source":{"sourceId":"s"},"preview":{"name":"mine","persistent":false}}', null),
                  ('ci', 'p', 'preview-up', 'preview', 'done', 8, 'b', now(), null, 'ci-dep'),
                  ('git', 'p', 'preview-rm', 'preview', 'done', 7, 'c', now(), null, null),
                  ('prod', 'p', 'deploy', 'production', 'done', 0, 'e', now(), null, null);`,
      );

      await migrateDatabase(old);

      const lanes = await old.query<{ id: string; lane: string }>(
        `select id, lane from "job" order by id`,
      );
      expect(lanes.rows).toEqual([
        { id: "ci", lane: "feature-x" },
        { id: "cli", lane: "mine" },
        { id: "git", lane: "pr-7" },
        { id: "prod", lane: "" },
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
        expect.arrayContaining(["user", "session", "organization", "invitation", "endpoint"]),
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
