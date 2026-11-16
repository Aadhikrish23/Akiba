# Sprint 1 — M1 Foundation

**Source:** [Roadmap M1](../10-roadmap.md) · **Process:** sprint-loop (developer → reviewer → tester) · **Base branch:** `ccr-0014c7e1-32mc28` · **Task branches:** `sprint-1/<slug>` · **Merge:** reviewer agent, squash · **Max fix rounds per task:** 3

Global rules: follow [SRS](../04-srs.md), [Architecture](../05-architecture.md), [Data model](../06-data-model.md), [API spec](../07-api-spec.md) and [Security](../09-security-privacy.md). Tests accompany every change. Never skip or weaken a test. No secrets in code or logs. PR body sections: Summary · Done when · Testing (what was run / not run) · Risks.

## Tasks (in order)

| # | Slug | Task | Done when | Status |
|---|---|---|---|---|
| T1 | `monorepo-ci` | pnpm workspace monorepo (`apps/api`, `apps/web`, `packages/shared`, `packages/api-client`, `packages/ui-tokens`, `packages/config`); TS strict; ESLint; Prettier; Vitest; GitHub Actions CI (install, lint, typecheck, test, build) with a Postgres 16 service | `pnpm i && pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass locally and in CI on a PR | **done** — PR #1, merge `b4456ba`, tester PASS, 0 fix rounds |
| T2 | `api-skeleton` | Express app: env config (zod), pino logging with request IDs, problem-details error handler, zod validation middleware, rate limiter, helmet/CORS, `/health` and `/ready`; `scripts/smoke.sh` + `scripts/smoke.d/` modular smoke harness and a post-merge smoke workflow | `curl /health` 200; invalid body → 422 problem+json; rate limit → 429 with `Retry-After`; smoke workflow green | **done** — commits `d6d7f81` `1fc91c2`, CI + smoke green, no review/test stage |
| T3 | `prisma-schema` | Prisma schema + first migration + seed for all M1 tables in doc 06 (user, oauth_account, refresh_token, one_time_token, title, title_external_id, title_relation, franchise, studio, genre, character, airing_episode, mapping_conflict, mapping_override, library_entry, viewing_run, event, notification, share_link) with constraints and indexes | `prisma migrate deploy` on empty Postgres succeeds; constraint tests (unique entry, one open run, notification uniqueness) pass | pending |
| T4 | `auth-core` | Register, login, refresh rotation with reuse detection, logout, logout-all; argon2id; JWT access tokens with pinned alg and `kid`; password policy incl. breached-password check (local list/stub interface); login throttling; CSRF/cookie handling for web; `X-Client: mobile` token transport | All doc 11 §3.1 core cases pass: rotation, reuse → family revoked, tampered/`none`/wrong-aud JWT → 401, identical errors for unknown vs wrong password, throttling | pending |
| T5 | `auth-email` | Email verification + password reset with single-use hashed tokens; `EmailSender` interface with dev/console and test implementations; reset revokes all sessions; no user enumeration | FR-AUTH-005/006 tests pass; forgot-password always 202 | pending |
| T6 | `auth-oauth` | Google and Apple sign-in (code+PKCE and mobile ID-token paths) with JWKS verification behind an `OidcVerifier` interface; link/unlink; never auto-link unverified emails | FR-AUTH-002/007 tests pass with a fake verifier; bad state/nonce/aud rejected | pending |
| T7 | `shared-client-tokens` | `packages/shared` Zod DTOs for auth + health; `packages/api-client` typed client; `packages/ui-tokens` with the Shelf tokens (light/dark) exported for web (CSS vars/Tailwind preset) and RN | Types compile across apps; client round-trips against the running API in a test; tokens match doc 08 | pending |
| T8 | `sources-adapters` | `SourceAdapter` interface; AniList adapter (search, browse, detail, relations); Jikan fallback adapter; normalisation to internal types; timeouts, retries with jitter, token-bucket limiter, circuit breaker; recorded fixtures (no live calls in CI) | Contract tests pass on fixtures; breaker opens after 5 failures and serves stale/fallback | pending |
| T9 | `akiba-id-mapping` | Resolver (exact external ID → dataset → create), dataset importer job, `mapping_conflict` queue, manual overrides, merge script; fixture set of tricky cases | doc 11 §3.3 suite passes incl. concurrent resolution creating one row and idempotent re-resolution | pending |
| T10 | `web-shell` | Vite + React + Tailwind shell using `ui-tokens`; router; auth screens (register, login, reset, verify) wired to the API client; light/dark; a11y basics | Playwright journey: sign up (dev email) → log in → logged-in shell → log out; axe-core clean on auth screens | pending |
| T11 | `m1-hardening` | Run the doc 09 §9 checklist; fill gaps; update docs/status to separate *verified* from *implemented-unverified*; end-to-end smoke of the full M1 stack | Checklist all checked or gaps documented; smoke green on the merged base | pending |

## Milestone exit (M1)
Auth security checklist (doc 09 §9) passes · mapping tests pass on fixtures · CI green · owner reviews the auth code.

## Status log
Update this table after each merged task: task, PR number, merge SHA, tester result, rounds used.
