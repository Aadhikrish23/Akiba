# T2 — api-skeleton: developer report

**Developer:** Claude Fable 5.2 · **Dates:** 2026-11-15 → 2026-11-16 · **Commits on `ccr-0014c7e1-32mc28`:** `d6d7f81` (API skeleton), `1fc91c2` (smoke harness + workflow), plus the commit adding this report.

**Process note.** The task started under the sprint-1 process (branch + PR + reviewer). Mid-task the coordinator changed it (docs/sprints/mvp-plan.md, "Process for this run"): no PR, push directly to the base. So there is no PR for T2. Work was done in a separate git worktree on a local branch `sprint-1/api-skeleton`, rebased on the base and pushed with `git push origin HEAD:ccr-0014c7e1-32mc28` (no force).

## 1. Plan (written before building)

Intent: give `apps/api` the cross-cutting plumbing every later task needs, with nothing domain-specific, and make each guarantee in the task text provable by a test or a smoke check.

- `createApp(dependencies)` takes config, logger, DB check, rate-limit store and an optional `/v1` router. Nothing reads `process.env` except `loadEnv()` in `server.ts`. This is what makes the integration tests possible without a public debug route.
- Middleware order: request ID → request log → helmet → CORS → rate limit → JSON body parser (100 KB) → routes → 404 → error handler. Rate limiting sits before the body parser so an over-limit client cannot make the server parse bodies; headers and CORS sit before it so error responses carry them.
- All failures go through one `HttpError` → RFC 9457 document path.
- Smoke: read-only shell checks against a running instance; the 429 proof uses a second, low-limit instance.

Alternatives considered:

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Rate limiter | Hand-written fixed-window limiter (~90 lines) with an async `RateLimitStore` interface | `express-rate-limit`: well tested, but one more dependency for a small amount of logic, and I wanted the store interface and key function under our control for the per-user limits doc 07 asks for later. Cost: we own the code. Sliding window/token bucket: more accurate at window edges, not needed for the starting values. |
| `/ready` DB check | Injectable `checkDb`; in T2 a TCP-connect probe to the host/port in `DATABASE_URL` | A pure stub that always says `not_configured`: allowed by the brief, but then the smoke workflow's Postgres service would prove nothing. Adding `pg` for `SELECT 1`: a DB client T3 (Prisma) would immediately replace, and the scope fence says no DB access yet. |
| 422 in smoke | Covered only in supertest integration tests through a test-only `/v1` router | A public validated/diagnostic endpoint: the brief forbids it. |
| Request logging | Own 20-line middleware logging method/path/status/duration | `pino-http`: logs request headers by default, so safety would rest on redaction alone. Not logging them at all is the stronger guarantee; redaction stays as a second layer. |
| CORS | `cors` package with an origin function + always `Vary: Origin` | Hand-rolled: small, but preflight handling is easy to get subtly wrong. |
| Problem `type` | Relative URI reference `/errors/<slug>` | An absolute URL: the public API origin is not decided (D-24) and I did not want to invent a domain. See open question 1. |
| Validated input | `validate(schemas)` + typed `getValidated(res, schemas)` reading `res.locals` | Overwriting `req.query`: it is a read-only getter in Express 5. |

## 2. What was built

`apps/api/src`:
- `config/env.ts`, `config/constants.ts` — zod env parsing; `EnvError` lists every problem by variable name and never echoes values. `apps/api/.env.example` documents every variable.
- `lib/logger.ts` — pino with redaction paths; `lib/errors.ts` — `HttpError`, problem document builder and factories; `lib/dbCheck.ts` — `DbCheck` type, `dbNotConfigured`, TCP probe; `lib/shutdown.ts` — idempotent graceful shutdown with force-close timeout.
- `middleware/requestId.ts`, `requestLogger.ts`, `error.ts`, `validate.ts`, `rateLimit.ts`, `security.ts`.
- `modules/health/health.routes.ts` — `GET /health`, `GET /ready` at the root (doc 07 §7 lists them without `/v1`; I mounted them at the root as the brief allowed).
- `app.ts`, `server.ts`; `testing/harness.ts` (test helper, excluded from the build).

Repo root: `scripts/smoke.sh`, `scripts/smoke.d/10-health.sh`, `scripts/smoke.d/20-rate-limit.sh`, `.github/workflows/smoke.yml`, README section.

Behaviour worth knowing:
- Status codes: unknown route 404; malformed JSON or undecodable URL 400; body over 100 KB 413; validation 422 with `errors[{path,message}]` (body fields bare, others prefixed `query.` / `params.`); rate limit 429 with `Retry-After` and `RateLimit-*`; unexpected 500 (generic detail in production; the error message, never the stack, outside production).
- Rate limits are per IP: global `API_RATE_LIMIT_MAX` (600/min) on everything except `/health`; `API_RATE_LIMIT_WRITE_MAX` (120/min) on non-GET/HEAD/OPTIONS. `createRateLimiter({ name, windowMs, max, store, keyGenerator })` is the factory T4 uses for 10/min/IP on auth (a test builds exactly that).
- `/ready`: 200 `{status:"ready",checks:{database,sources}}`; 503 problem+json with `checks` when the DB check fails or takes more than 2 s. `sources` is always `not_configured` until T8.

## 3. Additions beyond the task text (complete list)

1. `TRUST_PROXY_HOPS` env (default 0) → Express `trust proxy`. Per-IP limiting is wrong behind a proxy without it; with 0, `X-Forwarded-For` is ignored (tested).
2. `LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS`, `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_WRITE_MAX` env variables.
3. `DATABASE_URL` required when `NODE_ENV=production`.
4. Inbound `X-Request-Id` is only propagated if it matches `[A-Za-z0-9._:-]{1,128}`; otherwise replaced (log/header injection).
5. `RateLimit-Limit/Remaining/Reset` response headers.
6. Write limiter (120/min) wired globally for mutating methods, not just a factory.
7. `/health` exempt from rate limiting; `Cache-Control: no-store` on `/health` and `/ready`.
8. TCP reachability probe for `/ready` instead of a pure stub; `sources: "not_configured"` placeholder field.
9. 413 and 415 problem types; `X-Frame-Options: DENY`; `Vary: Origin` on every response.
10. Second smoke file `20-rate-limit.sh`; `SMOKE_EXPECT_DB`, `SMOKE_SKIP_RATELIMIT`, `SMOKE_WAIT_SECONDS` switches; a CORS-denial smoke check.
11. Smoke workflow step that sends SIGTERM to both instances and fails unless each logs `shutdown complete`.
12. README "API" and "Smoke tests" sections.
13. `src/testing/harness.ts` and the `src/testing` exclusion in `tsconfig.build.json`.

## 4. Deviations from the docs / brief

- **Per-IP, not per-user limits.** Doc 07 says writes 120/min/user and reads 600/min/user. There are no users before T4, so both are per IP. `keyGenerator` is the hook to switch.
- **Problem `type` is relative** (`/errors/validation`), not an absolute URL as doc 07's `…/errors/validation` suggests.
- **`/ready` does not check source adapters** (doc 07 §7 says "DB + source-adapter status"); adapters are T8.
- **`/ready` DB check is TCP-only.** `database: "ok"` currently means "the host accepts connections", not "credentials and schema work". Marked TEMPORARY in `lib/dbCheck.ts`; T3 should swap in a real query. Unix-socket `DATABASE_URL`s are not supported by this probe.
- **No PR**, and therefore no PR body, per the process change.
- **CI pipeline unchanged**: no audit/secret-scanning step added (doc 11 §6 mentions audit); out of T2's task text.
- When several env values are invalid, the "DATABASE_URL is required in production" rule is only reported once the other values are valid (zod runs cross-field checks last). Seen in the manual bad-env boot.

## 5. What I ran

Local, in the worktree, on the final code before commit (Node 22.23.4, pnpm 10.28.0):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm lint` (ESLint `--max-warnings 0` + Prettier check) | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass — api 75 tests in 6 files; other workspaces 28 tests unchanged |
| `pnpm build` | pass |

Built API run by hand (`NODE_ENV=production`, throwaway local Postgres 16 on port 55432, two instances on 3000 and 3001):

| Check | Result |
|---|---|
| `curl -i /health` | 200 `{"status":"ok"}` with the security headers |
| `curl -i /v1/nope` | 404 `application/problem+json` |
| POST with broken JSON | 400 `application/problem+json` |
| `/ready` with Postgres up | 200, `database: "ok"` |
| `/ready` after stopping Postgres | 503 problem+json, `database: "unavailable"`; `/health` still 200 |
| 6 requests to the `API_RATE_LIMIT_MAX=5` instance | 404 ×5 then 429 with `Retry-After: 60`, problem+json |
| `scripts/smoke.sh` with both instances | pass, 7 checks, 11 requests |
| smoke negative cases: rate-limit instance already exhausted; `SMOKE_RATELIMIT_URL` missing; wrong `SMOKE_EXPECT_DB`; nothing listening; DB down | each failed with exit 1, as intended |
| `SMOKE_SKIP_RATELIMIT=1 scripts/smoke.sh` | pass, prints SKIPPED |
| SIGTERM / SIGINT to the instances | both exited and logged `shutdown complete` |
| Boot with `PORT=abc CORS_ORIGINS='*'` | exit 1 with a two-line list of problems |
| grep of the API log for the DB password / `authorization` | 0 matches |

Mutation spot-checks (change reverted each time, file checksum confirmed): disabling pino redaction → redaction test fails; disabling the 429 branch → 7 tests fail; accepting any inbound request ID → 3 tests fail.

One early `X-Frame-Options: SAMEORIGIN` finding from the manual curl was fixed (now `DENY`, asserted in a test) before the final gate run.

CI and smoke on the pushed commits: see section 8.

## 6. What I did NOT run

- **A 422 over real HTTP against the built server.** No validated route exists in the production app, so 422 is proven only by supertest tests against `createApp` with a test-only router. The "invalid body → 422" done-when is met at that level, not by curl.
- `workflow_dispatch` of the smoke workflow (not needed once the push triggered it).
- shellcheck on the smoke scripts (not installed locally, not in CI).
- Any load or concurrency test of the limiter; any test with more than one API instance sharing limits (the in-memory store is per process — two instances mean double the budget).
- A real reverse proxy in front of the API; `TRUST_PROXY_HOPS` is tested only with supertest setting `X-Forwarded-For`.
- Coverage measurement (no coverage tooling configured; doc 11's 80% gate targets services/auth/mapping/tracking, none of which exist yet).
- Browser-side CORS behaviour; only headers were asserted.
- `apps/web` beyond the existing workspace tests/build.

## 7. Re-verified vs carried over (interruption)

The work was interrupted twice by coordinator resume messages (a usage-limit pause, then the process change). My context was intact both times, and on each resume I re-ran `git status` in the worktree and re-fetched the base before continuing. Nothing in section 5 is carried over from before an interruption: the tests, the smoke harness, the workflow, `.env.example` and every command in section 5 were written/run after the first resume, and the full lint/typecheck/test/build gate was run on the final tree immediately before committing. The only step done after that gate was a rebase onto one docs-only base commit (`46f4d2d`), which touched no code; I did not re-run the gate after the rebase and relied on CI for that.

Two of my own commands were stopped by the environment's safety checks and are worth recording: a `git checkout -- .` I had (wrongly) put at the end of a mutation-check command, which would have discarded uncommitted work, and an `rm -rf "$(cat file)"` for the temporary Postgres directory. Neither ran. I redid the mutation checks with targeted `sed` reverts and removed the temp directory by literal path.

## 8. CI and smoke workflow results

Checked with the GitHub Actions API for head `1fc91c2` (push to `ccr-0014c7e1-32mc28`), first attempt, no fix-forward commits needed:

| Workflow | Run | Result |
|---|---|---|
| CI (lint, typecheck, test, build) | [43812486154](https://github.com/Aadhikrish23/Akiba/actions/runs/43812486154) | success |
| Smoke (post-merge, production mode, Postgres 16) | [43812486190](https://github.com/Aadhikrish23/Akiba/actions/runs/43812486190) | success |

For the smoke run I read the per-step conclusions: build, both instance starts, "Run smoke tests" and "Stop API instances gracefully" all succeeded; the two failure-only log steps were skipped. I did not read the smoke step's own output lines in CI (the log tail I fetched only covered container teardown), so "7 checks" is confirmed locally and inferred in CI from the step's exit status. The run shows a GitHub warning that `actions/checkout@v4`, `actions/setup-node@v4` and `pnpm/action-setup@v4` target the deprecated Node 20 runtime; this also applies to T1's `ci.yml` and was left alone.

The commit that adds this report is docs-only; its CI/smoke result is in the developer's final message to the coordinator, not here.

## 9. Open questions for the coordinator

1. **Problem `type` base URL.** Keep relative `/errors/<slug>`, or is there a canonical origin to use? One constant (`PROBLEM_TYPE_BASE`).
2. **`/ready` when the DB is not configured** returns 200 with `database: "not_configured"` (only possible outside production). Acceptable, or should it be 503?
3. **Fail-closed limiter.** If a future shared store errors, requests fail with 500 rather than passing unlimited. Right for auth; for reads you may prefer fail-open.
4. **`/ready` is rate limited** (only `/health` is exempt) because it does I/O. If an orchestrator probes it from one IP more than 600 times a minute this would need changing.
5. **Non-production 500s include the error message** in `detail` (never the stack). Say if you want it generic everywhere.
6. Should CI gain shellcheck and a dependency audit step now, or at T11 hardening?
