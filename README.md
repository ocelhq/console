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
bun run db:push                                 # apply the schema
bun run dev                                     # http://localhost:3000
```

`docker compose up` creates two databases: `postgres` for the app and `ocelhq_test` for the
tests. Set `POSTGRES_PORT` to publish it on another host port, and change the URLs in
`.env.local` to match.

`bun run dev` reads `DATABASE_URL` from `.env.local` and hands it to the app as its
`postgres("main")` binding. `bun run dev:ocel` runs `next dev` under `ocel dev` instead, which
supplies the binding itself.

Sign-in works with email and password. GitHub sign-in needs `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` from an OAuth app whose callback is
`http://localhost:3000/api/auth/callback/github`.

Until the first release there are no migrations: `bun run db:push` applies the schema in
`packages/db/src/schema` directly.

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
`postgres://postgres:postgres@localhost:5432/ocelhq_test`, and push the schema there
themselves.

## License

[Apache-2.0](LICENSE)
