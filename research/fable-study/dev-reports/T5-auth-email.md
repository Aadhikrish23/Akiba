# T5 — auth-email: developer report

**Task:** email verification, password reset, password change, `EmailSender` (sprint 1, T5).
**Branch:** `ccr-0014c7e1-32mc28`, on top of `372e164`. **Process:** one developer agent, no reviewer or tester, no PR.
**Requirements:** FR-AUTH-005, FR-AUTH-006; doc 09 S-AUTH-10, S-AUTH-11, S-AUTH-3, §4, §7; doc 07 §2; Q-04, Q-08.

The commit SHAs and the CI and Smoke results for the pushed head are in section 9, filled in last.

## 0. Interruption

The work was cut off once by a usage limit, after the production code was written and committed locally (WIP) and while I was fixing the five existing tests that the new production-only `WEB_BASE_URL` requirement broke. My context survived the pause, so nothing was rebuilt from memory. After resuming I re-checked rather than assumed:

- `git status`, `git log`, `git diff`: one unpushed WIP commit plus the two uncommitted test files, as the coordinator described. The `docs/06-data-model.md` change is mine and intended (the `sent_to` column, section 3.1).
- The local Postgres had stopped; I restarted it, re-applied the migrations and re-ran `db:check`.
- Everything in section 7 ("what I ran") was run after the interruption, on the final tree. Nothing in that section is carried over from before it.

## 1. Plan (written before building)

1. Read carry-forward, sprint T5, doc 09 (all), doc 04 FR-AUTH-005/006, doc 07 §2, Q-04/Q-08, the T3 and T4 reports and the auth module.
2. Email module behind an `EmailSender` interface: console sender (default), in-memory test sender, templates, `EMAIL_PROVIDER` / `EMAIL_DEV_PRINT_LINKS` / `WEB_BASE_URL` config with fail-fast validation.
3. One-time token store on the existing `one_time_token` table: 256-bit random, SHA-256 at rest, atomic single use, per-purpose lifetime, newest-only.
4. Service methods and routes: verify, resend, forgot, reset, change; registration sends mail in both of its outcomes.
5. Decide how forgot-password avoids enumeration, including timing (section 3.2).
6. Integration tests on real Postgres with the in-memory sender; unit tests for sender, templates, config.
7. Smoke file limited to what production mode can prove without a link; workflow changes.
8. Self-audit against doc 09, report, carry-forward, sprint status; full gate; push; check CI and Smoke.

Changes to the plan while building: I added the `sent_to` column (step 3) once it was clear that "verify only the address the link went to" cannot be enforced without it, and I added a bounded wait for background work at shutdown.

## 2. What was built

| Area | Files |
|---|---|
| Email seam | `apps/api/src/modules/email/emailSender.ts` (`EmailSender`, `ConsoleEmailSender`, `MemoryEmailSender`), `templates.ts`, `index.ts` (`createEmailSender`) |
| One-time tokens | `apps/api/src/modules/auth/oneTimeTokens.ts` |
| Service and routes | `auth.service.ts`, `auth.routes.ts`, `index.ts`, `refreshTokens.ts` (revoke inside a transaction, optionally keeping one session) |
| After-response work | `apps/api/src/lib/backgroundTasks.ts`; `server.ts` waits up to 5 s for it at shutdown |
| Errors | `INVALID_TOKEN` (400), `REAUTHENTICATION_FAILED` (403), `EMAIL_NOT_VERIFIED` (403) in `lib/errors.ts` |
| Config | `EMAIL_PROVIDER`, `EMAIL_DEV_PRINT_LINKS`, `WEB_BASE_URL` in `config/env.ts`; token lifetimes and the email budget in `config/constants.ts`; `.env.example` |
| Contracts | `packages/shared/src/auth.ts`: verify, forgot, reset, change request and response schemas |
| Schema | migration `20261116020000_one_time_token_sent_to` |
| Smoke | `scripts/smoke.d/30-auth-email.sh`; `.github/workflows/smoke.yml` |
| Docs | doc 06 (column), doc 07 §2 (routes and statuses), README (smoke) |

Endpoints, all under `/v1/auth`, all behind the T4 per-IP limiter (10/min) and CSRF guard:

| Route | Auth | Result |
|---|---|---|
| `POST /verify-email` `{token}` | none | 200 `{status:"verified"}`; any unusable token 400 `INVALID_TOKEN` |
| `POST /verify-email/resend` | access token | always 202 `{status:"accepted"}` |
| `POST /password/forgot` `{email}` | none | always 202 `{status:"accepted"}` (422 for a malformed body, 429 from the per-IP limit) |
| `POST /password/reset` `{token,newPassword}` | none | 200 `{status:"password_reset"}`; 422 for a refused password; any unusable token 400 `INVALID_TOKEN` |
| `POST /password/change` `{currentPassword,newPassword}` | access token | 204; wrong current password 403 `REAUTHENTICATION_FAILED` |

## 3. Decisions, with the alternatives rejected

### 3.1 `one_time_token.sent_to` (a schema change)
The brief asks to mark an address verified on reset "only when the token was delivered to that email". The T3 table had no record of where a link went, so that could not be checked. I added `sent_to citext NOT NULL`. Verify and reset compare it with the account's current address; a mismatch means the link proves nothing about the current address.
- **Rejected: no column, and a note that the future change-of-email feature must delete tokens.** That makes a security property depend on a later task remembering it.
- **Rejected: nullable column.** A token without an address would be a second, weaker kind of token.
- Cost: two raw-SQL inserts in T3 tests needed the new column (I added a value; no assertion changed). The table had no writer before T5, so the backfill in the migration is a formality.

### 3.2 Forgot-password answers before it looks anything up
The handler validates the body, sends `202 {"status":"accepted"}`, and only then starts the work (account lookup, budget, token, email) as a background task. The response therefore cannot depend on whether the address has an account, in content or in timing.
- **Rejected: do the real work for known addresses and a dummy path for unknown ones, then respond.** The two paths can only be made approximately equal (a token insert needs a real user row), and the email provider's latency would sit in the response of one path only.
- Residual: background work shares the process and the database with later requests, so a very precise attacker on the same connection could in principle see load. I did not measure this. Locally the forgot response took 1 to 3 ms in both cases (production-mode smoke log), which is an observation from six requests, not a measurement.
- Consequence: a failure in the background (database down, provider down) is logged and the client still gets 202.

### 3.3 Email is sent after the response, in process
`BackgroundTasks` runs delivery after the response and logs failures by task name and error class only (an error message from a provider could quote the email, which contains the link). Registration keeps T4's guarantee: both outcomes hash once, answer 201 with the same body, and lead to exactly one email.
- **Rejected: await delivery in the request.** A slow or failing provider would then change response time or status.
- **Rejected for now: a job queue.** No queue exists yet. A message in flight when the process dies is lost; the user can ask again. Shutdown waits up to 5 s.

### 3.4 What an already-registered address receives
A notice ("someone tried to create an account with this address; you already have one; sign in, or reset your password") with no token. The HTTP response is identical to a fresh registration (tested on status, body, headers, cookies). No verification link is sent on this path: a link triggered by a stranger must not confirm anything.

### 3.5 Per-address email budget, silent
At most 3 emails of one kind per address per hour (`EMAIL_BUDGET`), for reset links, verification links and the registration notice. Over budget, the request still gets its normal answer, no email is sent and no new token is issued, so the link in the last delivered email keeps working. Security notices (password changed) are never suppressed.
- **Rejected: answer 429 per address.** Not an enumeration leak, but it tells an attacker exactly when they have blocked a victim, and it contradicts "always 202".
- The budget is checked before a token is issued; otherwise a suppressed request would kill the link the user already holds.
- The per-IP limit on these routes is the existing `/v1/auth` limiter (10/min), as the carry-forward asked.

### 3.6 Resend is authenticated
Doc 07 does not list a resend route. I chose `POST /auth/verify-email/resend` with an access token; the link goes to the caller's own address, never one named in the request. Unverified users can log in (3.9), so they can always reach it.
- **Rejected: unauthenticated resend by email.** A second endpoint that lets anyone trigger mail to any address, for no gain.

### 3.7 Reset
- Order: password policy and breached check first (a refused password must not burn the link), then hash, then one transaction: claim the token, set the hash, mark the address verified if it was not and `sent_to` still matches, revoke every refresh-token family, delete the user's remaining one-time tokens.
- The hash is computed before the token is looked at, so a wrong token costs the same as a right one (tested by counting hashes).
- Session revocation is in the same transaction as the password change. The carry-forward said "call `AuthService.logoutAll`"; I call the same store method inside the transaction instead, which is the same effect made atomic.
- Reset marks an unverified address verified: opening the link proves control of the mailbox, which is all verification establishes.
- Reset clears the login backoff for the address, and clears the browser's now-dead refresh cookie. It does not sign the user in.
- One generic 400 for unknown, malformed, tampered, wrong-purpose, expired, used, and "account in deletion".

### 3.8 Password change (S-AUTH-11)
"Recent re-authentication" is implemented as: the current password must be in the same request. Other sessions are revoked, the calling session stays, outstanding reset links die, the address is notified. A wrong current password is 403, not 401, so clients do not mistake it for "signed out". Guesses count against the same per-account backoff as login guesses. The new password must differ from the current one.
- **Email change is out of scope** (carry-forward for the settings task). The "email changed" template exists and is unit-tested but nothing sends it.

### 3.9 Q-04: unverified users can still log in
Unchanged from T4, on purpose: Q-04's default gates share links, not login. `emailVerified` is on `/me` and the login response and changes as soon as the link is used. For later features there is `auth.verifiedEmail`, a middleware to put after `authenticated`; it answers 403 `EMAIL_NOT_VERIFIED`.

### 3.10 Link format
`<WEB_BASE_URL>/verify-email#token=…` and `/reset-password#token=…`. The token is in the fragment, which browsers do not send to servers, so it stays out of web-server logs and `Referer`.
- **Rejected: query string.** It ends up in access logs and proxies.
- The web app must read the fragment, POST the token, and remove it from the address bar (carry-forward for T10).

### 3.11 Console sender and production
`EMAIL_PROVIDER` accepts only `console`; any other value stops the boot with the variable named. No SMTP stub: it would be untested code for an undecided provider. The console sender logs that an email of some kind was produced and nothing else. `EMAIL_DEV_PRINT_LINKS=true` prints the whole message to standard output and is refused when `NODE_ENV=production`. In production the sender keeps no messages in memory.
- `console` is allowed in production, with a warning at start-up, because no real provider exists and the smoke workflow runs in production mode. **In that configuration nobody receives a link.** A real provider is required before real users.
- `WEB_BASE_URL` is required and must be `https://` in production.

## 4. Self-audit against doc 09

| Requirement | Status | Where | Tests |
|---|---|---|---|
| **S-AUTH-10** random ≥ 128-bit | Done | `oneTimeTokens.ts`: `randomBytes(32)`, base64url | "tokens are 256 random bits, base64url, and never repeat" |
| **S-AUTH-10** hashed at rest | Done | SHA-256 hex in `token_hash`; raw token only in the email | "only the SHA-256 of a token is stored; the database never holds the raw token" |
| **S-AUTH-10** single use | Done | one `UPDATE … WHERE used_at IS NULL` claims the row | "works once" (verify, reset); two concurrency tests |
| **S-AUTH-10** expiry 1 h / 24 h | Done | `ONE_TIME_TOKEN` constants; checked in the claiming `UPDATE` | "expires after 24 hours", "expires after one hour" (both test one second before and at the deadline) |
| **S-AUTH-10** reset revokes all sessions | Done | `resetPassword`, same transaction | "sets the new password and revokes every session (refresh tokens and access tokens)" |
| New token invalidates older ones (brief) | Done | `issue` deletes unused tokens of the purpose | "resending issues a new link and the old one stops working", "a new reset request invalidates the earlier unused link" |
| **S-AUTH-11** password change needs re-authentication | Done | `changePassword` | seven tests under "POST /v1/auth/password/change" |
| **S-AUTH-11** notify the address | Done for password change and reset | `passwordChanged` template | asserted in the reset and change happy paths |
| **S-AUTH-11** email change | **Not done, out of scope** | — | — |
| **S-AUTH-3** no enumeration: forgot | Done; timing by construction, **not measured** | 3.2 | "always 202 with an identical response for verified, unverified, unknown and deleted addresses", "the response does not wait for…" |
| **S-AUTH-3** no enumeration: register | Done (response); T4's residual leak stands | 3.4 | "registering an existing address answers identically…" |
| **S-AUTH-3** no enumeration: tokens | Done | one `INVALID_TOKEN` problem | two "…all get the same answer" tests compare full responses |
| **S-AUTH-2** policy and breached check on reset and change | Done | `newPasswordSchema`, `assertNotBreached` | "the password policy applies on reset…", "a breached password is refused on reset…", change equivalent |
| **S-AUTH-4** throttling | Done for change (shared backoff) and per-IP on all routes | 3.8 | "guessing the current password is throttled like login guesses", "forgot is limited per IP…" |
| **S-AUTH-7** CSRF guard on new routes | Done | every route uses `guard` | "a browser request from an origin that is not allowed is refused" (forgot only; the others share the middleware and are not tested one by one) |
| **§3** user ID never from input | Done | resend and change use `getAuth(res)` | "the address comes from the session, not the request", "a body cannot name another account" |
| **§4** validation, unknown fields rejected | Done | `z.strictObject` for all four bodies | 422 tests per route; shared DTO tests |
| **§4** no injection through templates | Done | HTML escaping; control characters stripped from the display name | "a hostile display name cannot inject markup or extra lines" |
| **§7** no tokens, links, emails, passwords in logs | Done in tests and in one production-mode run | 3.3, 3.11 | "a full verify, forgot, reset and change run logs no token, link, password or email address"; console-sender tests; the new workflow step greps the smoke logs |
| **§7** no tracking | Done | templates have no images or remote content | "no tracking pixels, images, scripts, styles or remote content; every link goes to the web app" |
| **S-AUTH-12** seam | Kept | new methods are on the `AuthService` interface; email behind `EmailSender` | — |

I also broke the code on purpose six times to see whether the tests notice (removed session revocation on reset; removed the purpose check; removed the expiry check; stopped deleting older tokens; kept other sessions on change; dropped the `sent_to` comparison). Each change made 1 to 3 tests fail. All six were reverted; the tree was clean afterwards and the 47 tests passed again.

**Weak points I know of:**
1. No timing measurements anywhere. The claims are structural.
2. The pre-registration problem from T4 is reduced, not closed. If an attacker registers a victim's address, the victim's own reset replaces the password, ends the attacker's sessions and verifies the address. But if the victim instead opens the *verification* link from the attacker's registration, the account becomes verified while the attacker knows its password. The email says not to open the link if you did not register; that is wording, not a control. It needs an owner decision (section 8).
3. The email budget, the login backoff and the rate limits are per process and lost on restart.
4. Email delivery is in-process and can be lost on a crash.
5. `sameAddress` lower-cases in JavaScript; the database compares with `citext`. They agree for ASCII and may differ for unusual Unicode. A disagreement fails closed (the address is not verified).
6. Expired tokens are deleted only when the same user gets a new token. There is no cleanup job.
7. Nobody else has reviewed this code.

## 5. Additions beyond the task text

1. Migration adding `one_time_token.sent_to` (3.1); doc 06 updated.
2. `BackgroundTasks` and the 5-second wait at shutdown.
3. The per-address email budget also covers resend and the registration notice, not only forgot.
4. `auth.verifiedEmail` middleware and the `EMAIL_NOT_VERIFIED` problem, for T17.
5. Reset clears the login backoff and the refresh cookie, and deletes the user's other one-time tokens.
6. Change: new password must differ from the current one; guesses are throttled; outstanding reset links are deleted.
7. `WEB_BASE_URL` is required and https-only in production (this changed four existing tests' inputs and one expected error list).
8. Smoke workflow: a fourth API instance for `30-auth-email.sh`, `WEB_BASE_URL` in the environment, and a step that fails the job if the API logs contain a link, a token or a smoke email address (it first checks that the "email produced" line is present, so it cannot pass on empty logs).
9. Doc 07 §2 and README updated to match.

## 6. Deviations from the brief

- "Same work done" for forgot is achieved by answering before the work, not by a dummy path (3.2).
- Reset revokes sessions through the store inside the transaction rather than through `AuthService.logoutAll` (3.7).
- The generic token error is 400 (the brief allowed 400 or 422).
- The smoke file runs against its own instance; it makes 9 `/v1/auth` requests, which do not fit next to `20-auth.sh` on one instance.
- No `smtp` stub (3.11).

## 7. What I ran (all after the interruption, on the final tree)

Environment: Node 22, pnpm 10.28.0, PostgreSQL 16 from `/usr/lib/postgresql/16`, throwaway cluster in `/var/tmp/akiba-pg-t5`, port 55432, scram password auth.

| Command | Result |
|---|---|
| `pnpm lint` | pass (exit 0) after fixing one lint error and one formatting warning in a new test file |
| `pnpm typecheck` | pass (exit 0) |
| `pnpm db:migrate` on the test database | pass; 3 migrations applied |
| `pnpm db:check` | pass, "No difference detected" |
| `pnpm test` | pass (exit 0): API 19 files, 387 tests at the time of the full run; shared 15; config 9; ui-tokens 5; api-client 5; web 2. One test was added afterwards (see below) |
| `pnpm build` | pass (exit 0) |
| Production-mode smoke, four local instances, fresh migrated database | pass: 27 checks, 36 requests; I read the auth-email instance's log (29 lines) and grepped all four logs for `token=`, `verify-email#`, `reset-password#`, `@smoke.akiba.invalid`: 0 matches |
| Six deliberate breakages (section 4) | each caught |
| Workflow YAML | parsed with PyYAML |
| `bash -n scripts/smoke.d/30-auth-email.sh` | pass |

After the full gate I added the bounded shutdown wait and one test for it; section 9 records the final gate run on the exact tree that was pushed.

First full `pnpm test` after writing the production code failed with 5 tests, all from the new production-only `WEB_BASE_URL` requirement (expected; fixed by giving those tests the variable and updating one expected error list). First run of the new integration file had 3 failures, all mistakes in my tests (two used a 15-minute access token after advancing the clock an hour; one expected a used token row to be deleted). One unit test depended on log order and was fixed.

## 8. What I did not run or verify

- No real email provider; no message was ever delivered. HTML rendering in mail clients is untested.
- No timing measurements.
- `shellcheck` is not installed here; the smoke file was only syntax-checked and run.
- No test of the 5-second shutdown wait in a real process with a hanging provider (the unit test covers the timeout logic only).
- `EMAIL_DEV_PRINT_LINKS=true` was tested through an injected print function, not by reading a real console.
- `pnpm audit` was not run (no dependency was added).
- The web routes `/verify-email`, `/reset-password`, `/forgot-password`, `/login` that the emails link to do not exist yet (T10).

**Open questions for the owner**
1. Q-04: should an account whose address is unverified be allowed to log in at all? Today yes. Weak point 2 exists because of it.
2. Email provider (and a sender address). Until then production delivers nothing.
3. Should reset be allowed to set a password on an OAuth-only account? Today yes (mailbox proof). T6 should confirm.
4. Is 3 emails per kind per address per hour the right budget?

## 9. Commits and CI

Filled in after the push; see the end of this file.
