# Carry-forward notes (read before starting your task)

Open items and decisions passed from finished tasks to later ones. Developers: read this first; add items you create for later tasks; the coordinator prunes.

## From T2 (api-skeleton)
- Rate limits are **per IP** in T2. **T4** adds per-user limits for authenticated routes (doc 07: writes 120/min/user, reads 600/min/user) and the stricter auth limiter (10/min/IP) via the limiter factory.
- Problem-details `type` is a relative URI (`/errors/validation`); keep unless the owner supplies a canonical origin.
- No production route had a validated body in T2, so 422 was only proven by supertest; **T4** adds real validated routes and should add a smoke check for 422.
- Smoke harness: add a new `scripts/smoke.d/NN-name.sh` per feature; keep request counts within the smoke rate-limit budget; `99-` is reserved for replay/logout.

## From T3 (prisma-schema)
- `library_entry.removed_at` exists (soft-remove). Unique `(user_id, title_id)` still covers removed rows → **T15 must revive the tombstone on re-add**, not insert a new row.
- DB rejects `progress > episodes_total_override` → **T16 must decide** (and document) whether lowering an override clamps progress or is refused.
- `event` is append-only via trigger, which also blocks cascades → **T17 account purge** must run `set_config('akiba.event_maintenance','purge',true)` inside its transaction; a `merge` mode exists for **T9** title merges. See `prisma/README.md`.
- Requirement IDs: FR-REM-007 = events append-only; FR-REM-004 = rewatch/one open run.
- `pnpm test` needs `DATABASE_URL` with CREATEDB rights; test harness uses one DB per test file (citext). Local Postgres: `/usr/lib/postgresql/16` (initdb in a temp dir, port 55432).
- Prisma pinned to 7.10.1 (registry `latest` is an 8.x RC). Seed lives in `apps/api/src/db/`.
- Seed catalog facts were written from memory, not verified against AniList/MAL — do not treat as ground truth.
- **T19:** no column for the adult-content toggle yet — add a migration when needed (user setting).
- `date` columns cannot hold partial source dates (AniList can return year/month only) — handle in adapters (**T8**) by normalising.
- `/ready` now does a real `SELECT 1`; smoke checks it.

## From T4 (auth-core) — full detail in research/fable-study/dev-reports/T4-auth-core.md
- **Protecting routes:** every authenticated route uses the `authenticated` chain from `createAuthModule` (access token + live-session check + per-user limits) and reads the caller with `getAuth(res)`. Never take a user ID from input. Add IDOR tests per endpoint.
- **Register never reveals whether an address exists** (always 201, no tokens). **T5** must send the verification email, and the "you already have an account" email on the `register_existing` path.
- **T5:** password reset must call `AuthService.logoutAll(userId)`; new passwords go through `newPasswordSchema` + `BreachedPasswordChecker`; put new auth routes behind the `/v1/auth` limiter and CSRF guard.
- **Q-04 (owner):** unverified accounts can currently log in. Until that is decided, an attacker can pre-register someone else's address. **T6 must never link an OAuth identity to a password account whose email is unverified.**
- **T6:** create sessions with `RefreshTokenStore.startFamily` + `AccessTokenService.issue`; same transport rules (cookie for web, body for `X-Client: mobile/…`).
- **Clients (T7/T10):** send `X-Client: web/<ver>` on every request; access token in memory only; **only one refresh in flight, across tabs too** (a second request with the same refresh token is treated as theft and ends the session); web app and API must be same-site (`SameSite=Lax` cookie); 401 `INVALID_REFRESH_TOKEN` means signed out.
- **Schema:** `refresh_token.family_expires_at` was added (absolute 30-day deadline; `expires_at` is the 14-day idle deadline). Raw inserts into `refresh_token` need both.
- **Environment:** production refuses to start without `AUTH_JWT_PRIVATE_JWK` (`pnpm auth:gen-key`). Any workflow that boots the API in production mode must set it.
- **Smoke:** `20-auth.sh` sends 9 of the 10 allowed `/v1/auth` requests per minute per IP and leaves one `@smoke.akiba.invalid` account per run; needs `SMOKE_WEB_ORIGIN` on the API's `CORS_ORIGINS`. Later auth smoke checks need their own budget or instance.
- **T11 / before launch:** the breached-password list is 180 entries written from memory (replace it, or verify and enable `AUTH_HIBP_ENABLED`); run `pnpm audit`; tune argon2 on real hardware; decide on a pepper before the first real user; login throttle and rate-limit counters are per process (shared store needed for more than one instance); add a cleanup job for expired/revoked `refresh_token` rows; **independent review of the auth module has not happened**.
- **T17:** accounts with `deleted_at` set cannot log in, refresh or use access tokens, so restore-within-grace needs its own way in.
- Local Postgres for tests must use password auth (not `trust`): two T3 tests assert that a wrong password is refused.
- Lesson: run the whole suite before pushing a migration; `dcfa584` broke a raw-SQL test and left one red CI run.

## From T5 (auth-email) — full detail in research/fable-study/dev-reports/T5-auth-email.md
- **No email is delivered yet.** `EMAIL_PROVIDER=console` is the only provider; it logs that a message was produced and nothing else. Choosing a real provider (owner decision) means one new `EmailSender` in `apps/api/src/modules/email/` plus its name in `EMAIL_PROVIDERS`. Production needs `WEB_BASE_URL` (https).
- **Local development:** `EMAIL_DEV_PRINT_LINKS=true` prints emails with their links to the API console. Tests use `MemoryEmailSender` through `buildAuthTestApp` (`t.emails`, and `await t.settle()` before reading it: email is sent after the response).
- **T10 (web):** the emails link to `/verify-email#token=…`, `/reset-password#token=…`, `/forgot-password` and `/login`. The token is in the URL **fragment**: read it in the page, POST it to `/v1/auth/verify-email` or `/v1/auth/password/reset`, then remove it from the address bar. Forgot and resend always answer 202 `{status:"accepted"}`: show "if the address has an account, we sent a link". Any bad link is 400 `INVALID_TOKEN`. Password change: 403 `REAUTHENTICATION_FAILED` means the current password was wrong, not that the user is signed out. After a reset every session is gone, so send the user to login.
- **T17 (share links):** put `auth.verifiedEmail` after `auth.authenticated` on routes that need a verified address (Q-04); it answers 403 `EMAIL_NOT_VERIFIED`.
- **Settings task (email change, not built):** require the current password, send the `emailChanged` template to the OLD address, set `email_verified_at` to NULL, delete the user's `one_time_token` rows, and send a verification link to the new address. `one_time_token.sent_to` already stops an old link from verifying a new address.
- **T6:** reset currently sets a password on an OAuth-only account (mailbox proof). Confirm or forbid. A reset also marks the address verified. The verification email can be triggered by a stranger registering someone's address; never treat "verified" on a password account as proof that its password holder owns the mailbox when linking.
- **Schema:** `one_time_token.sent_to` (citext, NOT NULL) was added. Raw inserts into `one_time_token` need it.
- **Smoke:** `30-auth-email.sh` needs its own instance (`SMOKE_AUTH_EMAIL_URL`, port 3003 in the workflow) and uses 9 of its 10 `/v1/auth` requests. The workflow fails if any API log contains a link, a token or a smoke address. Workflows that boot the API in production mode must set `WEB_BASE_URL`.
- **T11 / before launch:** email budget (3 per kind per address per hour) and background email delivery are per process, in memory (lost on restart or crash; wrong with more than one instance); add a cleanup job for expired `one_time_token` rows; no response-time measurements exist for forgot or register; Q-04 (may unverified accounts log in?) is still open and leaves the pre-registration risk described in the T5 report.

## Standing rules
- No PRs, no merges, no reviewer/tester agents; commit and push directly to `ccr-0014c7e1-32mc28`, then check CI + Smoke and fix forward.
- Never pipe a gate (lint/typecheck/test) through `tail`/`head` in a way that hides its exit code (T3 lesson) — check exit codes.
- Validate workflow YAML before pushing (T3 lesson).
