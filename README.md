# Akiba (秋葉)

Anime discovery and personal library management. Product and engineering documentation lives in
[`docs/`](docs/00-README.md); the current sprint plan is [`docs/sprints/sprint-01.md`](docs/sprints/sprint-01.md).

## Repository layout

```
apps/
  api/            Express server: config, logging, errors, validation, rate limiting, health,
                  database module (src/db) and seed
  web/            React + Vite + Tailwind (placeholder until T10)
packages/
  shared/         Types, enums and constants shared by every app
  api-client/     Typed client for the API
  ui-tokens/      Design tokens for web and React Native
  config/         Shared tsconfig, ESLint and Prettier presets
prisma/           schema.prisma + migrations (see prisma/README.md); config in prisma.config.mjs
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
pnpm test        # Vitest in every workspace (the API tests need PostgreSQL, see "Database")
pnpm build       # build every workspace (tsc for packages and api, Vite for web)
pnpm format      # rewrite files with Prettier
```

`lint`, `typecheck`, `test` and `build` first run `pnpm generate` (the Prisma client, written to the
git-ignored `apps/api/src/generated/`); the first three also build `packages/*`, because apps
consume the packages through their compiled `dist/` output. To work on a single workspace, filter by package name:

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
`X-Request-Id` response header and the log lines for that request. `/ready` runs `SELECT 1`
through the database module and answers 503 when that fails (server down, wrong credentials,
missing database); `/health` never touches the database.

### Authentication

Implemented in `apps/api/src/modules/auth` to [docs/09-security-privacy.md](docs/09-security-privacy.md) §2;
the request/response schemas are in `packages/shared/src/auth.ts`.

| Endpoint                   | Notes                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/register`   | `{email,password,displayName}` → 201 `{status:"verification_pending"}`, the same whether or not the address already has an account                          |
| `POST /v1/auth/login`      | `{email,password}` → `{accessToken,tokenType,expiresIn,user}`; refresh token in an HttpOnly cookie (browsers) or in the body (`X-Client: mobile/<version>`) |
| `POST /v1/auth/refresh`    | rotates the refresh token; replaying a used one ends the whole session                                                                                      |
| `POST /v1/auth/logout`     | ends the session the refresh token belongs to; always 204                                                                                                   |
| `POST /v1/auth/logout-all` | needs the access token; ends every session of the user                                                                                                      |
| `GET /v1/me`               | needs the access token; `{id,email,displayName,emailVerified}`                                                                                              |

- **Signing key.** Access tokens are EdDSA JWTs. `pnpm auth:gen-key` prints a new key as an
  `AUTH_JWT_PRIVATE_JWK=...` line; it is required in production. Without it, development and test
  generate a key per process. To rotate, set a new key and move the public half of the old one to
  `AUTH_JWT_PREVIOUS_PUBLIC_JWK` for at least 15 minutes.
- **Browser clients** must send `X-Client: web/<version>` (or `desktop/<version>`) and come from an
  origin listed in `CORS_ORIGINS`; `/auth/refresh` and `/auth/logout` are refused otherwise. The
  cookie is `SameSite=Lax`, so the web app and the API must be on the same site.
- **Concurrent refreshes** with the same token are treated as a replay and end the session. A
  client must make sure only one refresh is in flight (across tabs as well).
- **Limits.** `/v1/auth/*` allows 10 requests per minute per IP; repeated failed logins for one
  address back off exponentially (capped at 15 minutes, never a permanent lock); authenticated
  routes are additionally limited per user.

## Database

PostgreSQL 16, managed by Prisma migrations. The schema is [`prisma/schema.prisma`](prisma/schema.prisma);
[`prisma/README.md`](prisma/README.md) lists what lives only in migration SQL (CHECK constraints,
the one-open-run index, the search column, the append-only guard on `event`) and how to write the
next migration. All commands read `DATABASE_URL` from the environment:

```sh
export DATABASE_URL=postgresql://akiba:change-me@localhost:5432/akiba?schema=public
pnpm db:migrate   # prisma migrate deploy: apply committed migrations
pnpm db:check     # migrate status + fail if the database differs from schema.prisma
pnpm db:seed      # build the API, then load genres + a small development catalog (idempotent;
                  # with NODE_ENV=production only the genres)
```

Application code gets database access only from `apps/api/src/db/index.ts` (`createDb`, the client
type, the `Prisma` namespace and the enums).

**Tests use a real PostgreSQL, never a mock.** `pnpm test` needs `DATABASE_URL` (or
`TEST_DATABASE_URL`) pointing at a server where the role may create databases. Each run creates a
template database `akiba_t_<run>_template`, applies the migrations to it with the real
`prisma migrate deploy`, and gives every test file its own copy (`createTestDatabase()` in
`apps/api/src/testing/database.ts`, with `reset()` between tests). Everything named `akiba_t_*`
from the run is dropped at the end; the database named in the URL is never touched. Without Docker,
a throwaway server is enough:

```sh
initdb -D /tmp/akiba-pg/data -U akiba --pwfile=<(echo local-only) --auth=scram-sha-256
pg_ctl -D /tmp/akiba-pg/data -o '-p 55432 -k /tmp/akiba-pg' -w start
createdb -h 127.0.0.1 -p 55432 -U akiba akiba_dev
export DATABASE_URL=postgresql://akiba:local-only@127.0.0.1:55432/akiba_dev?schema=public
```

### Smoke tests

`scripts/smoke.sh` runs every `scripts/smoke.d/NN-name.sh` in order against a running API. It is
read-only except for `20-auth.sh`, which registers one throwaway account per run (a unique
`@smoke.akiba.invalid` address, left behind) and needs `SMOKE_WEB_ORIGIN` to be an origin on the
API's `CORS_ORIGINS` list; it sends 9 requests to `/v1/auth/*`, so it can run once a minute against
the default auth limit. Three checks need their own instance, so no default is
weakened on the instance under test: the rate-limit check (a low limit), the readiness check
(a `DATABASE_URL` naming a database that does not exist, to prove `/ready` turns 503) and
`30-auth-email.sh` (its own `/v1/auth` budget: 9 more requests; it registers a second throwaway
account). `30-auth-email.sh` proves that forgot-password always answers 202 and that a wrong
one-time token gets the generic 400; it cannot follow a real link, because the API never logs
one, so the link flows are covered by the integration tests:

```sh
PORT=3001 API_RATE_LIMIT_MAX=5 node apps/api/dist/server.js &
PORT=3002 DATABASE_URL=postgresql://akiba:change-me@localhost:5432/akiba_missing node apps/api/dist/server.js &
PORT=3003 node apps/api/dist/server.js &
SMOKE_BASE_URL=http://127.0.0.1:3000 SMOKE_RATELIMIT_URL=http://127.0.0.1:3001 SMOKE_RATELIMIT_MAX=5 \
  SMOKE_DBDOWN_URL=http://127.0.0.1:3002 SMOKE_AUTH_EMAIL_URL=http://127.0.0.1:3003 scripts/smoke.sh
```

`SMOKE_SKIP_RATELIMIT=1`, `SMOKE_SKIP_DBDOWN=1`, `SMOKE_SKIP_AUTH=1` and `SMOKE_SKIP_AUTH_EMAIL=1` skip those files explicitly (for example
against a deployed API).

Add checks for a new feature as a new `smoke.d` file with a free number (session-ending checks such
as logout go in a `99-` file) and state in it how many rate-limited requests it sends.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to
the base branch: install (`--frozen-lockfile`, cached) → lint → typecheck → `prisma migrate deploy`
on the empty `postgres:16` service → migration status and drift check → test → build → seed twice.
The API tests create their own databases on the same service (see "Database").

[`.github/workflows/smoke.yml`](.github/workflows/smoke.yml) runs after every push to the base
branch (and on manual dispatch): it builds the API, applies the migrations and the production seed
to a `postgres:16` service, starts the API with `NODE_ENV=production`, runs `scripts/smoke.sh`,
checks that every instance shuts down cleanly on `SIGTERM`, and uploads the API logs if anything
fails.
