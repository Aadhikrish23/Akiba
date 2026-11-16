# Akiba (秋葉)

Anime discovery and personal library management. Product and engineering documentation lives in
[`docs/`](docs/00-README.md); the current sprint plan is [`docs/sprints/sprint-01.md`](docs/sprints/sprint-01.md).

## Repository layout

```
apps/
  api/            Express server: config, logging, errors, validation, rate limiting, health
  web/            React + Vite + Tailwind (placeholder until T10)
packages/
  shared/         Types, enums and constants shared by every app
  api-client/     Typed client for the API
  ui-tokens/      Design tokens for web and React Native
  config/         Shared tsconfig, ESLint and Prettier presets
scripts/          smoke.sh + smoke.d/ (HTTP smoke tests against a running API)
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

## API

`apps/api` validates its environment at boot and exits with a list of problems if anything is
invalid; [`apps/api/.env.example`](apps/api/.env.example) documents every variable.

```sh
pnpm build
cp apps/api/.env.example apps/api/.env            # then edit; .env is git-ignored
cd apps/api && node --env-file=.env dist/server.js
curl -i localhost:3000/health                     # liveness, no dependencies
curl -i localhost:3000/ready                      # readiness (database check)
```

Errors are RFC 9457 `application/problem+json` documents with a `requestId` that matches the
`X-Request-Id` response header and the log lines for that request. `/ready` currently checks only
that the database host accepts a TCP connection; a real query replaces it with the Prisma schema
(T3).

### Smoke tests

`scripts/smoke.sh` runs every `scripts/smoke.d/NN-name.sh` in order against a running API. It is
read-only and safe against a real database. The rate-limit check needs a second instance started
with a low limit, so no default is weakened:

```sh
PORT=3001 API_RATE_LIMIT_MAX=5 node apps/api/dist/server.js &
SMOKE_BASE_URL=http://127.0.0.1:3000 SMOKE_RATELIMIT_URL=http://127.0.0.1:3001 SMOKE_RATELIMIT_MAX=5 \
  scripts/smoke.sh
```

Add checks for a new feature as a new `smoke.d` file with a free number (session-ending checks such
as logout go in a `99-` file) and state in it how many rate-limited requests it sends.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to
the base branch: install (`--frozen-lockfile`, cached) → lint → typecheck → test → build. The job
starts a `postgres:16` service container and passes `DATABASE_URL` to the test step. No test uses
the database yet; it is wired up for the integration tests that arrive with the Prisma schema (T3).

[`.github/workflows/smoke.yml`](.github/workflows/smoke.yml) runs after every push to the base
branch (and on manual dispatch): it builds the API, starts it with `NODE_ENV=production` against a
`postgres:16` service, runs `scripts/smoke.sh`, checks that both instances shut down cleanly on
`SIGTERM`, and uploads the API logs if anything fails.
