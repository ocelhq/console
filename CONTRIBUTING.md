# Contributing

## Setup

```sh
mise install                                   # bun, node and buf at the pinned versions
bun install
docker compose up -d                           # Postgres for the app and the tests
cp apps/web/.env.example apps/web/.env.local   # then set BETTER_AUTH_SECRET
```

[README.md](README.md) covers running the app.

## Before you push

```sh
bun run lint
bun run typecheck
bun run test
```

If you touched `buf.gen.yaml` or need a newer proto, run `bun run gen` and commit the result.
CI runs all of these, regenerates `packages/connectors/src/gen` to check it matches, and
builds `apps/web`.

## Commits

- [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`.
- The subject says what is true after the change, not what you did:
  `fix(web): the variables page loads for a project with no environments`.
- The body gives the rationale. Commit messages and pull request bodies are the record of
  why; no file repeats them.
- No AI co-author, attribution or "generated with" lines.

## License

Contributions are licensed under [Apache-2.0](LICENSE).
