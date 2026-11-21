# M1 status: verified vs implemented-but-unverified

**Date:** 2026-11-18 · Written by T11 (`m1-hardening`). Nobody other than the developer who wrote
the code has reviewed any of it. "Verified" below means *an automated test in this repository
demonstrates it*, not that a person checked it.

## Doc 09 §9 checklist

| Item | State | Evidence / what is missing |
|---|---|---|
| argon2id parameters verified; hashing and policy tests | **verified** (parameters), **open** (hardware) | Tests pin 19 MiB / t=2 / p=1 and the dummy-hash path. The parameters have not been tuned on the hardware that will run the API. |
| Token rotation + reuse detection | **verified** | `auth.sessions.test.ts` (rotation, family revoke, concurrent use counts as reuse). The web client now serialises refreshes across tabs (Web Locks) and a client test reproduces the two-tab race without the lock. |
| No endpoint returns another user's data (IDOR suite) | **not applicable yet** | The only user-scoped endpoint is `GET /v1/me`. The generated IDOR suite is T20. |
| Rate limits active on auth and writes | **verified** | `auth.ratelimit`/throttle tests and the smoke workflow. **Per-process only** (see below). |
| CSP/headers; no tokens in `localStorage`; cookie flags | **verified** | API: deny-all CSP and helmet (API tests). Web: CSP meta tag in the build, and a Chrome test that the app runs without a single CSP violation or console error; another asserts empty `localStorage`/`sessionStorage`, no JS-readable cookie, and `akiba_refresh` is `HttpOnly; SameSite=Lax; Path=/v1/auth`. **Open:** a meta tag cannot carry `frame-ancestors`, HSTS or `Referrer-Policy`; the host serving the web app must send them (deployment phase). |
| OAuth state/nonce/PKCE tests | **deferred** | Product owner decision 2026-11-18: social sign-in will come from a separate auth module. Unmerged work: branch `wip/t6-auth-oauth`. |
| Logs reviewed for secrets/PII | **partly verified** | Redaction and "no link/token/address in logs" are asserted by tests and by the smoke workflow for the auth paths. Nothing new logs user data since T5; a human has not read production-like logs. |
| Dependency audit clean or exceptions documented | **exceptions documented** | `pnpm audit` (2026-11-18): 1 high, 1 moderate, both in development tooling: `picomatch` ≤ 4.0.7 via `vitest` (ReDoS on glob patterns) and `minimatch` via `typescript-eslint`. Neither is part of what the API or web app ships, and both only parse patterns from this repository. Re-check when upstream patches. |
| Electron hardening | **n/a** | M7. |
| Independent review of the auth module | **NOT DONE** | Still required before M1 sign-off. This cannot be satisfied by the author. |

## Implemented, behaviour verified only in tests (not against the real world)

- **Jikan adapter:** fixtures are hand-written to the documented v4 schema; Jikan was unreachable
  when they were made. AniList's adapter is tested against seven recorded live responses.
- **Mapping dataset import:** tested with hand-made rows; the real community dataset (e.g.
  Fribb/anime-lists) has not been downloaded or parsed.
- **Seed catalog** (T3): written from memory, not checked against AniList or MAL.
- **Breached-password list:** 180 entries from memory; HIBP lookup is off and has never been
  called. Either replace the list with a verified one or enable and verify HIBP before launch.
- **Tailwind theme** (`@theme inline` from `ui-tokens`) compiles and renders as designed
  (checked in Chrome and by screenshot), but only the auth screens use it so far.
- **Postgres:** tests ran on 17 locally and 16 in CI; the target is 16.

## Known gaps carried forward (nothing is hidden by a green build)

1. **Q-04:** an unverified account can log in, so an attacker can pre-register someone's address.
   Owner decision pending; the `verifiedEmail` middleware exists for features that need it.
2. **No email is delivered.** `EMAIL_PROVIDER=console` is the only provider (owner decision).
3. **State is per process:** rate-limit counters, login throttle, the per-address email budget and
   the background email queue live in memory. Correct for one instance only.
4. **Expired-token cleanup** now exists (`purgeExpiredAuthData`) but is not scheduled until T23.
5. **Partial source dates** (year-only announcements) are kept as-is by the adapters and stored as
   `NULL` in the `date` columns.
6. **Two flaky tests on this Windows machine** (not caused by code under test; both pass on CI's
   Linux in the earlier runs): the database-outage readiness test and one timing test in
   `auth.email.test.ts`.

## End-to-end check of the M1 stack

Browser tests (`pnpm --filter @akiba/web run e2e`, CI job `browser`) run the **built web app, the
built API and a migrated PostgreSQL** together in real Chrome: sign up, verify by the emailed link,
log in, shell, reload keeps the session, log out, password reset (old password stops working),
wrong password, WCAG 2.2 AA with colour contrast in light and dark, 375 px width, CSP, storage and
cookie flags.
