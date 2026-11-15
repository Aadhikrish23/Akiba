# Akiba (秋葉)

Anime discovery and personal library management. Product and engineering documentation lives in
[`docs/`](docs/00-README.md); the current sprint plan is [`docs/sprints/sprint-01.md`](docs/sprints/sprint-01.md).

## Repository layout

```
apps/
  api/            Express server (placeholder until T2)
  web/            React + Vite + Tailwind (placeholder until T10)
packages/
  shared/         Types, enums and constants shared by every app
  api-client/     Typed client for the API
  ui-tokens/      Design tokens for web and React Native
  config/         Shared tsconfig, ESLint and Prettier presets
docs/             Product, architecture and test documentation
```

Apps never import from each other; they depend on `packages/*` only. ESLint enforces this, and it
also bans `any` (explicit or leaking from untyped values) in `packages/*/src`.

## Running things

Requirements: **Node 22** (`nvm use` reads `.nvmrc`) and **pnpm 10** (`corepack enable` picks the
version pinned in `package.json`).

```sh
pnpm install     # install all workspaces
pnpm lint        # ESLint (type-aware) + Prettier check
pnpm typecheck   # tsc --noEmit in every workspace
pnpm test        # Vitest in every workspace
pnpm build       # build every workspace (tsc for packages and api, Vite for web)
pnpm format      # rewrite files with Prettier
```

`lint`, `typecheck` and `test` first build `packages/*`, because apps consume the packages through
their compiled `dist/` output. To work on a single workspace, filter by package name:

```sh
pnpm --filter @akiba/shared test
pnpm --filter @akiba/web dev          # Vite dev server
pnpm --filter @akiba/api build && pnpm --filter @akiba/api start   # listens on $PORT (default 3000)
```

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to
the base branch: install (`--frozen-lockfile`, cached) → lint → typecheck → test → build. The job
starts a `postgres:16` service container and passes `DATABASE_URL` to the test step. No test uses
the database yet; it is wired up for the integration tests that arrive with the Prisma schema (T3).
