# Ocel console

The UI over Ocel. Ocel (the CLI and SDK) is the deployment engine; the console is an optional
UI and API that gives a view into what it did and where it landed, never "a cloud". A console
may offer Ocel Cloud, the zero-config managed target; the console itself is not Ocel Cloud. README.md has the layout and
the commands; CONTRIBUTING.md is binding for every change.

## Stack

- Next.js 16 (App Router) in `apps/web`, running on Node.
- Postgres through `pg` and drizzle-orm 1.0 (`packages/db`). The pool comes from the Ocel
  resource `postgres("main")` in `packages/infra`; nothing reads `DATABASE_URL` at
  runtime except `scripts/dev-env.mjs`, which turns it into that binding.
- better-auth 1.7 (`packages/auth`) with the drizzle adapter.
- vitest for tests. Database tests run against a real Postgres at `TEST_DATABASE_URL`.
- biome for lint and format; `tsc --noEmit` per workspace for types.
- bun is the package manager and workspace runner only. Don't use Bun runtime APIs
  (`Bun.serve`, `Bun.sql`, `bun:test`, `Bun.file`); the code targets Node.

## Rules

- `bun run gen` (`buf generate && scripts/sync-ocel.sh`) writes, from the ocel commit
  `buf.gen.yaml` pins, `packages/connectors/src/gen`, `packages/api/test/contract` and
  `packages/pricing/catalog`. Never edit them by hand; CI fails when any of them differs from
  a fresh `bun run gen`.
- The schema changes through migrations: edit `packages/db/src/schema`, then `bun run db:generate`
  writes `packages/db/drizzle/`. Never hand-edit it. Each deploy applies them in `lifecycle.preBuild`
  (`drizzle-kit migrate` against `postgres("main")`), never the app at start.
- Shared versions (next, react, drizzle, better-auth, typescript) live in the root
  `workspaces.catalog`; packages depend on them as `catalog:`.
- Before pushing: `bun run lint`, `bun run typecheck`, `bun run test`.
- Conventional Commits. The subject says what is true after the change; the body gives the
  rationale.
- No AI co-author or attribution lines in commits or pull requests.
