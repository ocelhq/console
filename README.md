# Ocel console

The console is Ocel's hosted control plane: the web UI and API over projects, deployments,
variables and the connectors Ocel runs in a customer's account. Ocel deploys apps into the
customer's own cloud account, under their billing and access. The console hosts none of that
infrastructure, and using it is optional.

## Layout

| Path                  | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/web`            | The Next.js app: dashboard pages and the HTTP routes the `ocel` CLI calls  |
| `packages/api`        | The route handlers `apps/web/app/api` exports                              |
| `packages/auth`       | better-auth config: sessions, organizations, JWT, the CLI's device flow     |
| `packages/db`         | Drizzle schema, relations and client                                       |
| `packages/connectors` | The connector client; `src/gen` is generated from `buf.build/ocelhq/ocel`  |
| `packages/git`        | The git provider port, its GitHub adapter, and the sealed storage of apps  |
| `packages/infra`      | The Ocel resources the console declares (`postgres("main")`)               |
| `packages/theme`      | The design tokens shared with the other Ocel surfaces                      |
| `packages/variables`  | The variables table, rendered here and by the CLI's env UI                 |

## Prerequisites

- [mise](https://mise.jdx.dev): `mise install` installs the bun, node and buf versions
  `mise.toml` pins.
- Docker, for the local Postgres.
- The `ocel` CLI, only for `bun run dev:ocel`.

## Run locally

```sh
bun install
docker compose up -d                            # Postgres 17 on localhost:5432
cp apps/web/.env.example apps/web/.env.local    # then set BETTER_AUTH_SECRET
cd apps/web
bun run dev                                     # http://localhost:3000
```

`docker compose up` creates two databases: `postgres` for the app and `ocelhq_test` for the
tests. Set `POSTGRES_PORT` to publish it on another host port, and change the URLs in
`.env.local` to match.

`bun run dev` reads `DATABASE_URL` from `.env.local` and hands it to the app as its
`postgres("main")` binding. `bun run dev:ocel` runs `next dev` under `ocel dev` instead, which
supplies the binding itself.

Sign-in methods come from the env: `CONSOLE_EMAIL_AUTH=true` enables email and password, and
`GITHUB_CLIENT_ID` with `GITHUB_CLIENT_SECRET` enables GitHub, from an OAuth app whose callback
is `http://localhost:3000/api/auth/callback/github`. The console refuses to start with neither.
`CONSOLE_SIGNUP` is `invite` unless set to `open`.

The app applies the migrations in `packages/db/drizzle` when it starts. After changing the schema
in `packages/db/src/schema`, run `bun run db:generate`. A database made by the old `db:push` has
no migration record: recreate it (`docker compose down -v`).

## Self-host

The console deploys with `ocel` like any other app. Each target has a config at the root, and
every command names one with `-c`:

| Config               | Target                                                          |
| -------------------- | --------------------------------------------------------------- |
| `ocel.aws.config.ts` | AWS, with the database on Neon (`NEON_DATABASE_URL`)              |
| `ocel.vps.config.ts` | A machine you reach over SSH (`CONSOLE_VPS_HOST`, `_USER`, `_PORT`) |
| `ocel.gcp.config.ts` | Google Cloud (`GCP_PROJECT`, `GCP_REGION`); deploying it waits on Next.js and Cloud SQL support in ocel |

`CONSOLE_DOMAIN` in your shell sets the production hostname. With AWS as the example:

```sh
git clone https://github.com/ocelhq/console && cd console && bun install
export OCEL_CONFIG=ocel.aws.config.ts
ocel bootstrap production
ocel env set BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
ocel env set NEON_DATABASE_URL="postgres://…"
ocel env set CONSOLE_EMAIL_AUTH=true
CONSOLE_DOMAIN=console.example.com ocel deploy
```

The app applies its migrations when it starts.

Sign-in is configured with these variables:

| Variable                                     | Default  | Effect                                                     |
| -------------------------------------------- | -------- | ---------------------------------------------------------- |
| `CONSOLE_EMAIL_AUTH`                         | `false`  | Email and password sign-in                                 |
| `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`  | unset    | GitHub sign-in                                             |
| `CONSOLE_SIGNUP`                             | `invite` | `invite`: only the first user and invited emails sign up; `open`: anyone |
| `BETTER_AUTH_URL`                            | unset    | The public origin, when it is not the hostname ocel serves |

The console refuses to start with no sign-in method enabled. While sign-up is invite-only, the
first account created owns the console, so create yours right after the first deploy. If
someone else gets there first, delete their row from the `user` table.

Git integrations need `CONSOLE_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`),
which seals each GitHub App's private key and secrets before they reach the database. With it set,
an owner or admin registers a GitHub App of their own under Organization > Git: GitHub asks them
to confirm, and the console stores the app it hands back. To offer one app to every organization
instead, set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` together; the
console stores them as the system app at start, and removes it once they are unset. On that app,
set the webhook URL to `{origin}/api/git/github/system-github/webhooks`, the setup URL to
`{origin}/api/git/github/system-github/setup` with "Redirect on update" checked, and the callback
URL to `{origin}/api/git/github/system-github/authorized`. Whoever installs the app comes back
through the setup URL, signs in to GitHub, and the console connects the installation to their
organization once GitHub confirms their account can reach it.

Then point the CLI at your console:
`OCEL_CONSOLE_URL=https://console.example.com ocel login`,
`ocel link`, `ocel connector add`.

Known gaps: the console sends no email, so there is no password reset or email verification,
and a VPS database has no backups.

## Checks

From the repository root:

```sh
bun run typecheck   # tsc in every workspace
bun run test        # vitest in every workspace; needs the Postgres above
bun run lint        # biome
bun run format      # biome, writing fixes
bun run gen         # regenerate packages/connectors/src/gen
```

Tests read `TEST_DATABASE_URL`, which defaults to
`postgres://postgres:postgres@localhost:5432/ocelhq_test`, and migrate it themselves.

## License

[Apache-2.0](LICENSE)
