# Ocel console

The console is the UI over Ocel: the web UI and API over projects, deployments, variables
and the connectors Ocel runs in a customer's account. Ocel, the deployment engine, deploys apps
to a target: the customer's own cloud account, under their billing and access, or Ocel Cloud,
the zero-config managed target a console may offer. The console hosts no app infrastructure,
and using it is optional.

## Layout

| Path                  | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `apps/web`            | The Next.js app: dashboard pages and the HTTP routes the `ocel` CLI calls  |
| `packages/api`        | The route handlers `apps/web/app/api` exports                              |
| `packages/auth`       | better-auth config: sessions, organizations, JWT, the CLI's device flow     |
| `packages/db`         | Drizzle schema, relations and client                                       |
| `packages/connectors` | The connector client; `src/gen` is generated from ocel's `proto/`          |
| `packages/git`        | The git provider port, its GitHub adapter, the sealed storage of apps, and the CI pipelines projects trust |
| `packages/jobs`       | The job queue runners claim from, and the Ocel tasks that fill and report on it |
| `packages/infra`      | The Ocel resources the console declares (`postgres("main")`)               |
| `packages/targets`    | The console's OIDC issuer, and the targets that trust it                   |
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

`bun run dev` reads `DATABASE_URL` from `.env.local`, applies the migrations to it, and hands
it to the app as its `postgres("main")` binding. `bun run dev:ocel` runs `next dev` under
`ocel dev` instead, which supplies the binding itself; migrate its database with
`ocel run -c ../../ocel.aws.config.ts -- bun run --filter @console/db db:migrate`.

Sign-in methods come from the env: `CONSOLE_EMAIL_AUTH=true` enables email and password, and
`GITHUB_CLIENT_ID` with `GITHUB_CLIENT_SECRET` enables GitHub, from an OAuth app whose callback
is `http://localhost:3000/api/auth/callback/github`. The console refuses to start with neither.
`CONSOLE_SIGNUP` is `invite` unless set to `open`.

After changing the schema in `packages/db/src/schema`, run `bun run db:generate`, then
`bun run db:migrate` to apply it. A database made by the old `db:push` has no migration record:
recreate it (`docker compose down -v`).

## Git integration

The **Git Integration** page at `/git` holds the organization's GitHub Apps and installations
(`CONSOLE_ENCRYPTION_KEY` must be set). A project's own Git Integration page links it to a
repository of an installation, names its production branch, and chooses where its deploys run:

- **Console runners**: a push to the production branch queues a deploy, and a pull request
  queues a preview, for a runner to claim.
- **Your CI**: git events queue nothing. The project's GitHub Actions workflows deploy and report
  to the console, which posts each report on the pull request as a comment, a commit status and a
  GitHub deployment. Choosing it cancels deploys still waiting for a runner.

A project accepts reports from CI only from its **trusted pipelines**. Choosing Your CI trusts the
linked repository's pipeline, which can be narrowed but not removed while deploys run in CI; an
admin can add others by hand. A pipeline names a repository (pinned by id; a private one is pinned
by the first token that names it), optionally a workflow file and a GitHub environment, and the
branches it may deploy from as comma-separated patterns: `*` matches any run of characters,
slashes included, and everything else matches itself (`*`, `release/*`, `main`). A tag names no
branch and is refused.

The workflow authenticates with its GitHub Actions OIDC token (`permissions: id-token: write`),
requested with the console's origin as the audience, for example `https://console.example.com`.
A `pull_request` run may report only a preview, matched by its head branch; production needs a
push or another run outside a pull request. A `pull_request_target` run is held to previews too,
but its token names no pull request, so what it reports is recorded and nothing is posted.

## Targets and credentials

The console is an OIDC issuer, at `{origin}/oidc`, so a cloud account (a **target**) can trust an
organization of the console instead of trusting GitHub directly, and a trusted pipeline deploys
with short-lived credentials instead of stored keys. The issuer publishes
`{origin}/oidc/.well-known/openid-configuration` and its keys at `{origin}/oidc/jwks`; both are
404s until an issuer key is set (see Self-host).

1. From a checkout linked to this console, an owner or admin runs `ocel bootstrap production`
   (or `preview`). Bootstrap calls `console.v1.TargetService.Prepare`, which finds or creates the
   organization's target for the vendor, account and region and answers the organization, the
   issuer and the target's audience (`ocel-target:{target id}`). Bootstrap makes the account trust
   the issuer for that audience and the organization's target, creates the tier's deploy role (AWS)
   or service account (GCP), then calls `RecordTier`. The console checks the identity lives in the
   target's account (an IAM OIDC provider for this issuer and a role, or a workload identity
   provider and a service account of the project), stores it with the ocel version that recorded
   it, and binds the linked project's tier to the target. `ForgetTier`, which
   `ocel bootstrap --remove` calls, forgets a tier's identity; its bindings stay, and issue nothing
   until bootstrap records the tier again.
2. A CI run calls `IssueCredential` with its GitHub Actions token. The console admits the token as
   it admits a report, then gates it by the pipeline's **credential grant**, not the branches it
   reports from. The project tier must be bound to a target of the vendor the run deploys to, whose
   tier has a recorded identity. What the identity may do is the cloud's business: a deploy whose
   identity bootstrap made with an older ocel is refused by the CLI, which says to run
   `ocel bootstrap` again.
3. The console mints a ten-minute ES256 token: `aud` the target's audience, `sub`
   `org:{org}:target:{target}:tier:{tier}:project:{project}`, and `org`, `target`, `tier` and
   `project` claims. AWS matches the subject against `…:project:*`; GCP maps `google.subject` from
   the `target`, `tier` and `project` claims and conditions on `org` and `target`. The run exchanges
   the token at the cloud's STS for the tier's deploy identity.

A trusted pipeline's credential grant names, per tier, the branches whose runs get credentials,
always within the branches the pipeline itself takes: production from a `push` or
`workflow_dispatch` run, optionally only in one GitHub environment, so its protection rules gate
them; previews from a `pull_request` run's head branch or a `push` or `workflow_dispatch` run's
branch. Every other event, `pull_request_target`, `workflow_run` and `schedule` among them, gets no
credentials. Only `*` names every branch. The linked repository's pipeline starts granted
production from the production branch, which it follows, and previews from every branch; a
pipeline an admin adds starts with no grant. Grants are edited on a project's Targets page, which
also binds each tier to one of the organization's targets.

The organization's Targets page lists its targets and tiers, the issuer URL and the recent
issuances. **Test connection** mints a one-minute token for a tier, for the reserved project
`connection-test`, which the trust bootstrap writes admits, with a `purpose: test` claim,
logs it as a test without touching the tier's last issue, and exchanges it at AWS STS (`AssumeRoleWithWebIdentity`) or Google STS and
`generateAccessToken`, reports the outcome and discards the credentials. **Remove target** forgets
its tiers and bindings, so the console stops minting for it; the account trusts the issuer until
`ocel bootstrap --remove` runs there.

Security model:

- The issuer signs with a key of its own, never better-auth's session key, so neither key forges
  the other's tokens.
- Tokens live ten minutes (one for a connection test), and each is good for one target: its
  audience is that target's.
- Subjects are pinned to the organization, target, tier and project, so a cloud trust written for
  one organization's target admits no other's.
- A run's GitHub token is spent once, in the transaction that logs what was minted for it: every
  issuance is recorded with the pipeline, the run and the token's id, and the log outlives a removed
  project or target.

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

Each deploy applies the migrations in `packages/db/drizzle` before it builds, from the machine
running `ocel deploy`, through `lifecycle.preBuild`: `drizzle-kit migrate` against the deployed
`postgres("main")`. A failed migration stops the deploy, so the running release keeps serving.
To migrate without deploying, run
`ocel run --env production -- bun run --filter @console/db db:migrate`.

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
URL to `{origin}/api/git/github/system-github/authorized`, and grant it read access to
organization members. Whoever installs the app comes back through the setup URL, signs in to
GitHub, and the console connects the installation to their organization once GitHub confirms
their account owns the account it is installed on, or is an owner of that organization.

Git events become jobs on a Postgres queue (`job`, claimed by a `runner` under a lease) through three
Ocel tasks the console declares in `packages/jobs/src/tasks`: `git-event` turns a webhook delivery into
jobs, `git-sync` reports a job's state to GitHub, and `lease-sweep` runs every minute to requeue a claim
nobody started, fail a run that stopped reporting, and report again any change whose report was lost.
A push to a project's production branch (the repository's default branch unless the link names
another) queues a deploy, and a pull request queues, replaces and removes its preview, reported in the
`preview/pr-<n>/<project>` environment. A queued job waits for a runner; nothing runs it until runners
exist, and a pull request from a fork queues nothing. A managed runner takes only a job labelled
`managed`; an organization's own runner takes any of its projects' jobs whose labels it holds. Tasks
put these requirements on the target you deploy to:

- AWS: the console must run on serverless compute, since an app on container compute can't send to
  a task yet. The tier must not be an ephemeral preview, which refuses to declare one.
- GCP: install the tier's task support once, with `ocel bootstrap production --features tasks`
  (after `gcloud services enable pubsub.googleapis.com cloudtasks.googleapis.com`).
- VPS: run `ocel bootstrap` again if the box's agent predates the ocel you deploy with. The console
  already runs on container compute there, which tasks support.

A console can offer an Ocel Cloud as the target of projects that name no provider. These
variables configure the offer; with `CONSOLE_CLOUD_URL` unset the console offers none:

| Variable                     | Default                           | Effect                                                   |
| ---------------------------- | --------------------------------- | -------------------------------------------------------- |
| `CONSOLE_CLOUD_URL`          | unset                             | The Ocel Cloud API the CLI deploys to                    |
| `CONSOLE_CLOUD_PROVIDER_URL` | unset                             | The hosted provider the CLI reaches for day-2 commands   |
| `CONSOLE_CLOUD_AUDIENCE`     | the origin of `CONSOLE_CLOUD_URL` | The `aud` of the tokens the console signs for Ocel Cloud |

`ocel login` asks the console what it offers (`console.v1.ConsoleService.Describe`, no session
needed), then trades the session for five-minute Ocel Cloud tokens
(`ConsoleService.IssueCloudToken`) signed for the organization the request names, with the
scopes it asks for when the caller's role allows them all: members get `cloud.apps.read` and
`cloud.apps.write`, admins add `cloud.variables.write`, owners add `cloud.variables.reveal`.
Ocel Cloud verifies them against `{origin}/api/auth/jwks`, so it must trust this console's origin
and expect the same audience.

The CLI links each Ocel Cloud job to `/cloud/jobs/{id}?org={organization id}`. That page reads
the job from `cloud.v1.JobService` at `CONSOLE_CLOUD_URL` with a one-minute token of the same
shape, signed for that organization (the viewer's active one when the link names none), and polls
its events through `/api/cloud/jobs/{id}/events`. The console stores none of it but the
deployment a finished job reports. Without an offer, for an organization the viewer doesn't
belong to, or for a job Ocel Cloud doesn't show that organization, the page is a 404.

Targets need an issuer key, separate from `BETTER_AUTH_SECRET`. With neither set, the console
issues no credentials and its `/oidc` routes are 404s:

| Variable                             | Effect                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `CONSOLE_ISSUER_KMS_KEY_ID`          | An AWS KMS `ECC_NIST_P256` `SIGN_VERIFY` key the issuer signs with; wins over `CONSOLE_ISSUER_KEY` |
| `CONSOLE_ISSUER_KEY`                 | A P-256 private key, PEM or JWK, for consoles without KMS               |
| `CONSOLE_ISSUER_PREVIOUS_KMS_KEY_ID` | A retired KMS key whose public half stays published                    |
| `CONSOLE_ISSUER_PREVIOUS_KEY`        | A retired P-256 key (private or public), whose public half stays published |

With KMS the private key never leaves AWS. Create the key and let the console's runtime role use it:

```sh
aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --description "console issuer"
# then allow kms:Sign and kms:GetPublicKey on its ARN to the role the console runs as, and set
# CONSOLE_ISSUER_KMS_KEY_ID to the ARN (the console reads the key's region from it)
```

A console ocel deploys to AWS cannot use it yet: every app role sits under the tier's permissions
boundary, which allows no `kms:Sign` or `kms:GetPublicKey`. Use `CONSOLE_ISSUER_KEY` there, set
with `ocel env set CONSOLE_ISSUER_KEY="$(openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt)"`.

The key id (`kid`) is the key's JWK thumbprint. To rotate, move the current key to the `PREVIOUS`
variable and set a new current one: the console signs only with the current key and publishes
both, so tokens already minted keep verifying. Drop the previous key once the JWKS cache (five
minutes) and the longest token (ten minutes) have passed.

Then point the CLI at your console:
`OCEL_CONSOLE_URL=https://console.example.com ocel login`,
`ocel link`, `ocel connector add`.

Known gaps: the console sends no email, so there is no password reset or email verification,
and a VPS database has no backups.

### Product analytics

The console sends nothing anywhere unless you set both PostHog variables:

```sh
ocel env set CONSOLE_POSTHOG_TOKEN=phc_…                       # the project token, public
ocel env set CONSOLE_POSTHOG_HOST=https://us.i.posthog.com    # or eu., a managed proxy, or your own
ocel env set CONSOLE_POSTHOG_UI_HOST=https://us.posthog.com   # only behind a proxy
```

With them set, browsers send pageviews, clicks, heatmaps, errors and session replays straight
to `CONSOLE_POSTHOG_HOST`. A PostHog managed proxy on your own domain keeps them past ad
blockers and keeps the visitor's location. Each signed-in user is identified by their user id with their name and email, and grouped by their
active organization. Inputs are masked in replays everywhere; the text of variable values and
anything inside an element marked `data-private` is masked too, and clicks there send no event.
Whether replays are recorded is set in the PostHog project.

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
