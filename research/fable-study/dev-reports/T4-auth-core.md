# T4 — auth-core: developer report

**Developer:** Claude Fable 5.2 · **Date:** 2026-11-16 · **Branch:** `ccr-0014c7e1-32mc28` (direct commits, no PR, no reviewer or tester, per docs/sprints/mvp-plan.md "Process for this run").

**Commits:** `dcfa584` (migration + dependencies), `714231f` (auth module, DTOs, tests), `7a5be94` (smoke, key generator, README), `56141cf` (dummy hash at start-up), plus the commit that adds this report. CI and Smoke results are in section 9.

**This is hand-rolled authentication that nobody but its author has read.** Section 5 is the line-by-line self-audit; section 11 lists what I think the owner should look at first.

## 0. Interruption

The run was cut off by a usage limit after the first working-tree changes and resumed later.

- **In the working tree at the interruption, uncommitted:** the three new dependencies, `zod` in `@akiba/shared`, the `family_expires_at` schema change and its migration. Nothing else existed yet.
- **Re-verified after resuming:** `git status`/`git diff` matched that list; the throwaway Postgres had died and was restarted; the migration was re-applied to a database, `pnpm db:check` (status + drift) passed, and the full gate was run from scratch several times later (section 8). Nothing from before the interruption is reported here on trust.
- **A mistake caused by resuming:** I committed and pushed `dcfa584` right away to protect the work, before running the whole API suite. That commit broke one existing test (`eventAppendOnly.test.ts` inserted a `refresh_token` row without the new NOT NULL column), so **CI run #13 on `dcfa584` is red**. It is fixed in `714231f`. Smoke on `dcfa584` was green.

## 1. Plan (written before building)

1. Read doc 09 in full and list every S-AUTH-n that T4 owns (1–8, 12) versus later tasks (9 → T6, 10/11 → T5 and account tasks).
2. Decide the data question first: doc 06's `refresh_token` has one `expires_at`, but S-AUTH-6 needs an idle deadline per token and an absolute deadline per family. Add `family_expires_at` by migration.
3. Build bottom-up, each piece behind an interface and unit-tested before the next: password hashing and policy → breached-password checker → login throttle → access tokens → refresh-token store → `AuthService` → HTTP transport (cookie, CSRF, mobile) → routes → middleware.
4. Inject the clock everywhere (token lifetimes, throttle, limiters) so expiry, idle and backoff tests are deterministic and never sleep.
5. Tests against real Postgres through supertest for everything observable over HTTP; use production argon2 parameters in tests (no weakened test config).
6. After the tests pass, mutate the code (remove one protection at a time) and confirm a test fails each time.
7. Smoke: one file inside the default 10/min auth budget; a real 422.
8. Self-audit against doc 09 §2/§3/§4/§9 and write down every gap.

## 2. What was built

| Area | Files |
|---|---|
| Migration | `prisma/migrations/20261116010000_refresh_token_family_expiry/`, `prisma/schema.prisma` |
| Shared DTOs | `packages/shared/src/auth.ts` (+ test) |
| Config | `apps/api/src/config/env.ts` (auth variables), `constants.ts` (lifetimes, argon2 floor, backoff, cookie) |
| Auth module | `apps/api/src/modules/auth/`: `password.ts`, `breachedPasswords.ts`, `commonPasswords.ts`, `loginThrottle.ts`, `accessTokens.ts`, `refreshTokens.ts`, `auth.service.ts`, `transport.ts`, `auth.routes.ts`, `index.ts` |
| Middleware | `apps/api/src/middleware/auth.ts` (`requireAuth`, `getAuth`, `userRateLimit`) |
| Wiring | `apps/api/src/server.ts` (one rate-limit store, auth module mounted under `/v1`) |
| Errors, logging | `lib/errors.ts` (401/403 problems), `lib/logger.ts` (more redacted keys) |
| Tooling | `scripts/gen-jwt-key.mjs` (`pnpm auth:gen-key`), `apps/api/.env.example`, README "Authentication" |
| Smoke | `scripts/smoke.d/20-auth.sh`, `.github/workflows/smoke.yml` |
| Test harness | `apps/api/src/testing/auth.ts` |

Endpoints: `POST /v1/auth/register`, `/login`, `/refresh`, `/logout`, `/logout-all`, `GET /v1/me`.

**Request pipeline of an auth route:** global per-IP limiter → write limiter → JSON parser (100 KB) → per-IP auth limiter (10/min) → `Cache-Control: no-store` → CSRF guard → Zod validation → handler → `AuthService`.

## 3. Library choices

| Need | Chosen | Rejected, and why |
|---|---|---|
| argon2id | **`@node-rs/argon2` 2.2.2** (Rust reference implementation, prebuilt N-API binaries as optional dependencies, no install script) | **`argon2` (node-argon2):** equally credible, but it relies on an install script/`node-gyp-build`; pnpm 10 only runs install scripts for packages listed in `onlyBuiltDependencies`, so it would need an exception there and a compiler as fallback. **`crypto.argon2` built into Node:** not available in Node 22. **`hash-wasm`/pure JS:** slower, and less used for server-side password hashing. **scrypt (built in):** doc 09 requires argon2id. |
| JWT | **`jose` 6.2.17** (no dependencies, WebCrypto, takes an algorithm allow-list and a key resolver) | **`jsonwebtoken`:** no native EdDSA support, and its history includes algorithm-confusion pitfalls when the allow-list is omitted. **Hand-written verification with `node:crypto`:** exactly what "do not invent crypto" forbids. |
| Signature algorithm | **EdDSA (Ed25519)**, pinned | **HS256:** a shared secret means every verifier can also mint tokens, and rotation needs secret distribution. **RS256/ES256:** fine, but larger tokens/keys and (ES256) nonce-sensitive signing; doc 09 prefers EdDSA. |
| Cookie parsing | **`cookie` 2.0.2** (`parseCookie`), writing through Express's own `res.cookie` | **`cookie-parser`:** middleware for every route when one route family reads one cookie. **Splitting the header by hand:** avoidable parsing code in a security path. |
| Refresh-token hashing, randomness | `node:crypto` (`randomBytes(32)`, SHA-256) | A slow hash (argon2/bcrypt): pointless for a 256-bit random value and would prevent the indexed lookup. |
| CSRF | Own 60-line guard (Origin allow-list + required header) | **`csurf`:** deprecated. Token-based double-submit: needs a readable cookie and more client code; doc 09 specifies SameSite + custom header + Origin. |

Versions are the newest stable at the time (`pnpm view`). I did not run a dependency audit (`pnpm audit`); see section 10.

## 4. Decisions

### 4.1 Registration and user enumeration
**Chosen: always `201 {"status":"verification_pending"}`**, whether the address is new or already registered. No tokens are issued by register. For an existing address nothing changes and the caller is not told; the password is still hashed once so both paths do the same work (asserted in a test).

- **Why not 409:** it is a free oracle for "does this person have an account". Doc 07 says "→ 201, verification email sent" and doc 09 forbids enumeration on forgot-password; a 409 here would undo that.
- **Cost:** a real user who registers twice gets no immediate feedback. **T5 must send the "you already have an account" email** on this path (the code logs `register_existing` where that belongs). Until T5 the second registration is silently ignored.
- **Residual leak (unavoidable now):** an attacker can register a victim's address with a password of their choice and then try to log in. Success means the address was free. This costs a real account creation per probe and is rate-limited, but it exists until login requires a verified email (open question Q-04).
- **Related risk for T5/T6 (not fixed here):** because unverified accounts can log in, an attacker can pre-register someone else's address. T6 must never link an OAuth identity to an unverified password account, and T5/Q-04 must decide what an unverified account may do.

### 4.2 Session revocation: database lookup on every authenticated request
`sid` in the access token is the refresh-token family ID. `requireAuth` verifies the JWT, then runs one indexed query: does this family, owned by this user, still have a token that is not revoked and not expired, and is the user not in deletion?

- **Why:** logout, logout-all and reuse detection take effect on the next request, not up to 15 minutes later. The task text asks for the session to be validated as not revoked.
- **Cost:** one primary-key-indexed query per authenticated request. At this project's scale that is negligible.
- **Rejected:** *no check* (stateless JWT): revocation would lag by the token lifetime. *In-memory cache with a short TTL:* reintroduces a revocation delay and is wrong with more than one instance. *Redis denylist:* no Redis in the stack. Revisit only if profiling shows this query matters; the place to add a cache is `AuthService.authenticate`.

### 4.3 Concurrent refresh is treated as reuse (strict)
Rotation starts with `UPDATE refresh_token SET revoked_at = now WHERE token_hash = ? AND revoked_at IS NULL`. PostgreSQL's row lock guarantees exactly one concurrent caller gets the row. The others find the token revoked, which is the reuse path, so **the family is revoked, including the winner's brand-new token**. Tested with 8 parallel requests, 3 rounds: exactly 1 × 200, 7 × 401, one successor row, family dead.

- **Why strict:** S-AUTH-6 says reuse revokes the family; a grace window ("the same token within N seconds is fine") is precisely the window a thief needs.
- **Consequence for clients (T7/T10, carried forward):** a client must never send two refreshes with the same token. A web app open in two tabs must serialise refresh across tabs (Web Locks or BroadcastChannel), otherwise the user is logged out at random. If the owner prefers a short grace window instead, that is a deliberate weakening and should be decided explicitly.

### 4.4 Other decisions
- **Extra column `refresh_token.family_expires_at`** (deviation from doc 06, section 7). Alternatives rejected: deriving the family start from the oldest row (breaks once old rows are pruned); making the first token's ID the family ID (same problem, and obscure).
- **Signing keys as JWK JSON in the environment** (`AUTH_JWT_PRIVATE_JWK`, optional `AUTH_JWT_PREVIOUS_PUBLIC_JWK`). `kid` = RFC 7638 thumbprint. Required in production; outside production a missing key is replaced by one generated for the process, with a warning. No key of any kind is committed except the RFC 8037 published test vector, labelled as such, used only to load a production-shaped config in tests.
- **Pepper** goes into argon2's own `secret` input, not string concatenation.
- **Passwords are NFKC-normalised** before hashing and verifying (NIST SP 800-63B), so the same characters typed on different platforms match. Length is counted in code points. Nothing is trimmed or truncated.
- **Login does not apply the password policy** (only non-empty, ≤ 1024). A policy error at login would describe the stored password and would lock out accounts that predate a policy change.
- **Per-account throttle counts attempts up front**, not failures afterwards, so parallel guesses cannot all pass through one open window. It is keyed by lower-cased email whether or not the account exists (no enumeration through throttling). A refused attempt does not extend the wait.
- **Per-user rate limits reuse the per-IP numbers** (`API_RATE_LIMIT_MAX`, `API_RATE_LIMIT_WRITE_MAX`); doc 07 gives both the same values (600 reads, 120 writes).
- **`X-Client` is required on cookie-authenticated routes** and selects the transport: `mobile/…` → body, anything else → cookie. A web client cannot pass a refresh token in the body, and a mobile client is never authenticated by a cookie.
- **Logout needs no access token**: the refresh token identifies the session, so a user whose access token has expired can still log out. **Logout-all needs the access token.**
- **Dummy hash is created when the module is built**, not lazily (commit `56141cf`): otherwise the first failed login per process would do a hash plus a verify.

## 5. Self-audit against doc 09

Status words: **Done** = implemented and tested. **Partial** = implemented with a stated gap. **Deferred** = not in T4.

### §2 Authentication requirements

| # | Status | Implementation | Tests (file → name prefix) |
|---|---|---|---|
| **S-AUTH-1** argon2id, floor, salt, pepper | **Done** (tuning: not done) | `password.ts` `Argon2idHasher`: argon2id v19, m=19456 KiB, t=2, p=1, 32-byte output, library-generated 16-byte salt per hash; pepper via argon2 `secret`; constructor and env validation both refuse values below the floor. | `password.test.ts` → "S-AUTH-1: produces argon2id v19 hashes…", "…fresh salt per hash", "…refuses parameters below the floor", "…honours raised parameters", "…a pepper is required to verify…"; `env.test.ts` → "S-AUTH-1: argon2 parameters can be raised but never set below the floor", "…the pepper must be long…"; `auth.http.test.ts` → "S-AUTH-1 / NFR-SEC-001: stores an argon2id hash, never the password". **Gap:** "tuned on target hardware" is not done; there is no target hardware yet. The floor is the default. |
| **S-AUTH-2** policy 10–128, no composition, breached, no truncation | **Partial** | `packages/shared/src/auth.ts` `newPasswordSchema` (code points, no trim); `BreachedPasswordChecker` with `LocalListChecker` as default; `HibpRangeChecker` optional, off. | `shared/auth.test.ts` → "S-AUTH-2: accepts 10 to 128…", "…counts code points…"; `password.test.ts` → "S-AUTH-2: does not truncate…", "…does not trim…", "…NFKC", all "breached-password checkers" tests; `auth.http.test.ts` → "S-AUTH-2: rejects %s with 422" (7 cases), "…accepts 10 and 128 characters, spaces and Unicode…", "…rejects a breached password with 422…", "…uses the injected BreachedPasswordChecker". **Gap:** the local list is 180 passwords I wrote from memory. It satisfies the letter ("a local list") and not the intent. The HIBP checker is tested only against a fake fetcher, never the live service. Carried forward. |
| **S-AUTH-3** identical errors, constant-time, dummy hash | **Done** (timing: structural only) | `auth.service.ts` `login`: one `hasher.verify` in every path, against the dummy hash for unknown email, OAuth-only account, account in deletion; one `invalidCredentials()` for all. Comparison is constant-time inside the argon2 library. Throttle keyed regardless of existence. | `auth.http.test.ts` → "S-AUTH-3: unknown email and wrong password are indistinguishable (status, headers, body)", "S-AUTH-3: the dummy-hash path is taken: exactly one argon2 verification in every failure case", "S-AUTH-3: an existing email gets the identical response…", "S-AUTH-3 / S-AUTH-4: backoff is identical for an unknown email…"; `password.test.ts` → "S-AUTH-3: never throws for a malformed or foreign stored hash", "…the dummy hash is a real hash…". **Gap:** I did not measure response times. The tests prove the same work is done (same number of hashes/verifications), not that the durations are statistically indistinguishable. The unknown-email path skips nothing but also does no session insert; that difference only exists on success. |
| **S-AUTH-4** per-IP and per-account throttling, backoff, no permanent lockout | **Done** (single instance) | Per-IP: `createRateLimiter({name:'auth', max: 10})` on the whole `/v1/auth` router. Per-account: `MemoryLoginThrottle` (5 free attempts, then 1 s doubling, cap 15 min, forgotten after 30 min quiet, 50 000 keys max). | `loginThrottle.test.ts` (8 tests, all "S-AUTH-4: …"); `auth.http.test.ts` → "S-AUTH-4: per-IP: the 11th auth request within a minute is 429 with Retry-After", "…default per-IP auth budget is 10 per minute", "…per-account: after 5 failures the account backs off exponentially, even for the right password", "…no permanent lockout: the wait is capped at 15 minutes and the right password then works". **Gaps:** both stores are in process memory: state is lost on restart and not shared between instances. An attacker can keep a known address delayed by up to 15 minutes at a time (inherent to per-account throttling). Spraying more than 50 000 addresses evicts old entries. |
| **S-AUTH-5** JWT 15 min, pinned alg, claims validated, no sensitive claims, `kid` rotation | **Done** | `accessTokens.ts`: `algorithms: ['EdDSA']`, key chosen by `kid` only, `iss`/`aud`/`typ` checked, `sub`/`sid`/`iat`/`exp` required, `sub` and `sid` must be UUIDs, clock tolerance 0. Claims are IDs only. Current + previous key. `scripts/gen-jwt-key.mjs`. | `accessTokens.test.ts` (16 tests): issue shape; expiry boundary; `none`; HS256/384/512 with four encodings of the public key as secret; tampered payload/signature; foreign key with our `kid`; missing `kid`; embedded `jwk` header; wrong/missing `iss`; wrong/missing `aud`; bad `sub`/`sid`; missing `exp`; wrong `typ`; unknown `crit`; garbage; rotation; generator script. `auth.sessions.test.ts` → "JWT abuse cases over HTTP" (8 tests: control, `none`, HS256, tampered, wrong aud/iss, expired, missing/unknown kid, previous key) and "S-AUTH-5: an expired access token is 401…". |
| **S-AUTH-6** opaque 256-bit, hashed, rotated, family, reuse revokes family, 30 d / 14 d | **Done** | `refreshTokens.ts`: `randomBytes(32)` base64url; SHA-256 hex stored; `rotate` in one transaction with the conditional UPDATE; `replaced_by_id` set; reuse → all live tokens of the family revoked; idle = `expires_at` (now + 14 d, clamped), absolute = `family_expires_at` (login + 30 d); DB CHECK `expires_at <= family_expires_at`. | `auth.sessions.test.ts` → "FR-AUTH-003: web refresh rotates the cookie…", "S-AUTH-6: rotation revokes the old token, links it to its successor…", "…a chain of rotations works; every token is single-use", "FR-AUTH-003 / S-AUTH-6: reuse of a rotated refresh token revokes the whole family and its session", "S-AUTH-6: reuse detection works deep in a chain…", "…unknown, malformed or missing refresh token is 401 and revokes nothing", "…idle timeout…", "…absolute timeout…", "…concurrent refreshes with the same token: exactly one succeeds (atomic rotation)", "…concurrent refreshes of DIFFERENT sessions do not interfere", "…a user in deletion cannot refresh…"; `auth.http.test.ts` → "S-AUTH-6: stores only the SHA-256 of the refresh token…"; `constraints.test.ts` → CHECK on the new column. **Gap:** expired and revoked rows are never deleted (no cleanup job). |
| **S-AUTH-7** cookie flags, access token in memory, CSRF | **Done** (server side) | `transport.ts`: cookie `akiba_refresh`, `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth`, `Max-Age` = idle deadline, no `Domain`. `Secure` can be turned off only when `NODE_ENV` is development or test (env validation). CSRF guard: Origin allow-list on all auth routes; on `/refresh` and `/logout` additionally `X-Client` required and Origin (or Referer) required. Access token only in the JSON body; refresh token never in the body for browsers. | `auth.http.test.ts` → "S-AUTH-7: the refresh cookie is HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=14 days", "…cookie flags per environment…", all 12 tests under "CSRF defence for the cookie transport (S-AUTH-7)", "…the refresh cookie alone never authenticates an API request"; `env.test.ts` → "S-AUTH-7: the Secure cookie flag can be turned off in development and test only"; smoke asserts the flags on a production-mode instance. **Not verifiable here:** "never `localStorage`" is a client rule (T10). **Constraint:** `SameSite=Lax` means the web app and the API must be on the same site (e.g. `app.example.com` and `api.example.com`). |
| **S-AUTH-8** mobile tokens in SecureStore; desktop as web | **Partial** (server half) | `X-Client: mobile/<ver>` → refresh token in the JSON body, read from the body, no cookie set or read. `desktop/<ver>` behaves as web. | `auth.http.test.ts` → "S-AUTH-8: mobile login … returns the refresh token in the body and sets no cookie", "S-AUTH-8: a mobile client is never authenticated by a cookie"; `auth.sessions.test.ts` mobile refresh/logout tests. **Deferred:** actual storage in Expo SecureStore is the mobile app's job (later milestone). |
| **S-AUTH-9** OAuth | **Deferred → T6** | Not in scope. Note for T6 in section 4.1 (never link to an unverified password account). | — |
| **S-AUTH-10** verification/reset tokens | **Deferred → T5** | Not in scope. `one_time_token` table exists from T3. Reset must call `AuthService.logoutAll` ("reset revokes all sessions"); the method exists. | — |
| **S-AUTH-11** re-auth for password/email change, notify | **Deferred** → the account task that adds password/email change (no such endpoint exists; not listed in sprint 1) | Not in scope. | — |
| **S-AUTH-12** auth isolated behind an interface | **Done** | `AuthService` interface is the only thing routes and middleware use; `requireAuth` depends on a one-method `AccessTokenAuthenticator`; `PasswordHasher`, `BreachedPasswordChecker`, `LoginThrottle`, `AccessTokenService` are interfaces; `modules/auth/index.ts` is the single composition point. | Indirect: the tests inject a recording hasher, a custom breached checker and a clock through those seams. No test swaps the whole `AuthService`. |

### §3 Authorization

| Line | Status | Notes / tests |
|---|---|---|
| Queries on user-owned tables scoped by `user_id` from the verified token, never from input | **Done for auth** | `getAuth(res)` is the only source of the user ID; `logoutAll(userId)` and `getUser(userId)` take it from there. `isSessionActive` requires the family to belong to the token's user. Tests: "NFR-SEC-004: each access token resolves to its own user only" (also sends `?userId=` and `X-User-Id` of another user), "…a validly signed token naming another user's session (sub=A, sid=B) is rejected". The one lookup not scoped by user is by refresh-token hash, where the token itself is the credential. |
| Repository helpers require `userId`; no unscoped accessor | **N/A yet** | No domain repositories exist. `authenticated` (exported from the auth module) is the chain later modules must use. |
| Unknown and not-owned both 404 | **N/A** | No resource endpoints yet. |
| Automated IDOR tests per endpoint | **Done for the auth endpoints** | `auth.sessions.test.ts` "isolation between users" (4 tests): B's logout, logout-all, reuse detection and access token never affect A. |
| Share-link code path | **Deferred** (M-later) | — |

### §4 Input, output and transport

| Line | Status | Notes / tests |
|---|---|---|
| Validate every body/query/param with Zod; reject unknown fields on writes; max body 100 KB | **Done** | All five POST routes use `validate()` with `z.strictObject`. Tests: "S-AUTH-2: rejects unknown fields and a missing body", "…rejects unknown body fields and over-long tokens with 422"; smoke proves a real 422. `GET /me` takes no input. 100 KB limit is T2's (unchanged). |
| Prisma parameterised queries only; no string-built SQL | **Done** | The auth module contains no raw SQL at all (rotation uses `updateManyAndReturn`). Tests feed `' OR 1=1 --` as a token and as `sid`. |
| Output encoding / React rules | **N/A** (no UI) | — |
| Security headers via helmet | **Unchanged from T2** | Additionally `Cache-Control: no-store` on every auth response and on `/me` (asserted). |
| CORS allow-list, credentials only for those | **Unchanged from T2**, now load-bearing | Test: "S-AUTH-7: CORS preflight from a hostile origin is not approved, so X-Client cannot be sent". |
| TLS everywhere outside local dev | **Deferred** (deployment) | The cookie is `Secure` and HSTS is sent, but nothing here terminates TLS. |

### §9 Security checklist

| Item | Status after T4 |
|---|---|
| argon2id params verified; unit tests for hashing and policy | **Met** at the floor (tests above). Hardware tuning not done. |
| Token rotation + reuse-detection test passes | **Met** (and survives mutation, section 6). |
| No endpoint returns another user's data (IDOR suite green) | **Met for the six existing endpoints.** The suite must grow with every later endpoint. |
| Rate limits active on auth and writes | **Met**: per-IP global/write (T2), per-IP auth 10/min, per-account backoff, per-user read/write. All in memory, single instance. |
| CSP/headers verified; no `localStorage` tokens; cookie flags correct | **Partly**: headers (T2) and cookie flags verified, also by smoke in production mode. `localStorage` is a web-client check (T10). |
| OAuth state/nonce/PKCE tests | **Not started** (T6). |
| Logs reviewed for secrets/PII | **Partly**: an automated test runs a full session at debug level and asserts no password, token, hash, signing key or email appears; I also read the production-mode smoke log by eye (34 lines). That is not a human review by someone else. |
| Dependency audit clean or exceptions documented | **Not done** (`pnpm audit` not run; T11). |
| Electron hardening | **Not applicable yet** (M7). |
| Independent code review of the auth module | **NOT DONE.** No reviewer agent ran, by process decision. This is the open M1 exit item. |

## 6. Mutation check (does a test fail when a protection is removed?)

After the suite was green I removed one protection at a time, ran the auth tests, and restored the file with `git checkout`. Every mutant was caught:

| Mutation | Tests that failed |
|---|---|
| Rotation UPDATE without `revoked_at IS NULL` (not atomic, revoked tokens usable) | reuse, concurrent-refresh, logout tests (6+) |
| `authenticate` skips the session lookup | reuse, absolute-timeout, concurrent, logout tests (6+) |
| No dummy hash (early return for unknown user) | "the dummy-hash path is taken" |
| Reuse detected but family not revoked | reuse (2), concurrent |
| CSRF guard off for cookie routes | 4 CSRF tests |
| Session lookup not bound to the user | "sub=A, sid=B is rejected" |
| Absolute deadline not enforced | "absolute timeout" |

Not mutated: the JWT verifier options (removing `algorithms` would probably still be refused by `jose` because the key is an Ed25519 key; the pin is defence in depth and I did not prove a test depends on it), the throttle, the cookie flags.

## 7. Additions beyond the task text, and deviations from the docs

**Additions (complete list):**
1. Column `refresh_token.family_expires_at` + CHECK constraint (new migration).
2. NFKC normalisation of passwords.
3. `Cache-Control: no-store` on auth responses and `/me`.
4. `HibpRangeChecker` is a working implementation with an injectable fetcher rather than a bare stub (still off by default, no network in tests). Flag: `AUTH_HIBP_ENABLED`.
5. Environment variables: `AUTH_JWT_PRIVATE_JWK`, `AUTH_JWT_PREVIOUS_PUBLIC_JWK`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `AUTH_PASSWORD_PEPPER`, `AUTH_ARGON2_MEMORY_KIB`, `AUTH_ARGON2_TIME_COST`, `AUTH_COOKIE_SECURE`, `AUTH_HIBP_ENABLED`, `API_RATE_LIMIT_AUTH_MAX`.
6. Origin allow-list check on **all** auth routes (login and register too), not only the cookie-authenticated ones. Reason: login CSRF.
7. Referer accepted as a fallback when Origin is absent on cookie routes.
8. Refresh failure clears the browser's cookie.
9. Security event log lines (`register`, `login`, `login_failed`, `login_throttled`, `refresh_reuse`, `logout_all`) carrying user and session IDs only.
10. More redacted logger keys (`passwordHash`, `tokenHash`, snake-case variants, pepper, key fields, cookie name).
11. Accounts in deletion (`deleted_at` set) cannot log in, refresh or authenticate.
12. `refresh_token.user_agent` is stored, truncated to 255 characters (the column is in doc 06).
13. README "Authentication" section; `SMOKE_SKIP_AUTH`, `SMOKE_WEB_ORIGIN`, `SMOKE_EXPECT_SECURE_COOKIE`.
14. Tests for the key generator script.

**Deviations from the docs:**
1. **Doc 06** lists no `family_expires_at`. Added (4.4).
2. **Doc 07 §2** `register`: "201, verification email sent". 201 is returned; **no email is sent** (T5). Body is `{status:"verification_pending"}`; the doc gives no body.
3. **Doc 07 §2** login response gains `tokenType` and `expiresIn`; refresh returns the same shape without `user`. Additive.
4. **Doc 05 §6** shows the cookie without `Path`; doc 09 has `Path=/v1/auth`. Followed doc 09.
5. **Task text:** "logout-all … idempotent". It is idempotent in effect, but a repeat with the same access token returns **401**, because that token's session no longer exists. A test documents this. Making the repeat return 204 would mean accepting access tokens of revoked sessions on that route; I chose not to.
6. **Task text:** smoke file is `20-auth.sh` next to the existing `20-rate-limit.sh` (two files share the number; order is alphabetical, auth first). No `99-` file was needed.
7. **Smoke is no longer read-only:** each run leaves one account `smoke-…@smoke.akiba.invalid` behind. No deletion endpoint exists before T17.
8. **Existing tests changed** (none weakened): two raw-SQL inserts into `refresh_token` in `constraints.test.ts` and `eventAppendOnly.test.ts` gained the new column; `env.test.ts` defaults and the production-environment case now include the auth settings; `app.test.ts` production config gained a signing key.

## 8. What I ran (final state, commit `56141cf` plus this report)

Local environment: Node 22.23.4, pnpm 10.28.0, PostgreSQL 16 from `/usr/lib/postgresql/16`, `initdb` in `/var/tmp/akiba-pg`, port 55432, password authentication (the T3 tests for "wrong password" need it; with `trust` auth two T3 tests fail, which is an environment effect I hit and fixed, not a code problem).

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass (exit 0) |
| `pnpm lint` | pass (exit 0) |
| `pnpm typecheck` | pass (exit 0) |
| `pnpm db:migrate` on an empty database | pass (exit 0), both migrations |
| `pnpm db:check` (status + drift) | pass (exit 0) |
| `pnpm test` | pass (exit 0): API 323 tests in 16 files (was 179), shared 13, config 9, ui-tokens 5, api-client 5, web 2 |
| `pnpm build` | pass (exit 0) |
| `scripts/smoke.sh` against a local production-mode build (3 instances, fresh database, generated key) | pass: 20 checks, 27 requests; run twice |
| Production boot without `AUTH_JWT_PRIVATE_JWK` | exits 1 with the expected message |
| SIGTERM on all three instances | each logged "shutdown complete" |
| Workflow YAML parsed with PyYAML | both files load; `bash -n` on the smoke scripts passes |
| Mutation check (section 6) | 7 of 7 mutants caught |

Auth test files: `accessTokens.test.ts` 16, `auth.http.test.ts` 52, `auth.sessions.test.ts` 36, `loginThrottle.test.ts` 8, `password.test.ts` 17; plus `env.test.ts` 37 (14 new), `logger.test.ts` 3 (1 new), `shared/auth.test.ts` 6.

Doc 11 §3.1 coverage: register/login/logout happy paths ✔ · error equivalence ✔ · refresh rotation ✔ · reuse → family revoked ✔ · expired and idle tokens rejected ✔ · JWT wrong alg, `none`, tampered, wrong aud/iss, expired → 401 ✔ · throttling after N failures ✔ · password policy and breached rejection ✔. **Not covered because out of scope:** reset happy path and forgot-password enumeration (T5), all OAuth cases (T6).

## 9. CI and Smoke

| Commit | CI | Smoke |
|---|---|---|
| `dcfa584` | **failure** (run #13; the purge test, see section 0) | success (run #8) |
| `714231f` | no run of its own (pushed together with `7a5be94`) | — |
| `7a5be94` | success (run #14) | success (run #9), including `20-auth.sh` on a production-mode instance |
| `56141cf` | success (run #15) | success (run #10) |
| report commit (docs only) | see the final message of this run | see the final message of this run |

The last row cannot be filled in here: this file is part of that commit.

## 10. What I did NOT run or verify

- **Timing parity** of login failures: not measured (structural test only).
- **A real browser:** cookie handling, `SameSite`, CORS preflight and the CSRF guard were exercised with supertest and curl, which send whatever headers they are told. No browser has made these requests.
- **HIBP range API:** never called. `createHibpFetcher` is untested code.
- **TLS, a reverse proxy, `TRUST_PROXY_HOPS` > 0:** not exercised. Behind a proxy with the wrong hop count, every client shares one IP (or can spoof one), which changes what the per-IP limits mean.
- **More than one API instance:** rate-limit and throttle state is per process.
- **Load:** argon2 at 19 MiB per hash under concurrent logins was not load-tested; the per-IP limit bounds it per client only.
- **`pnpm audit` / dependency review:** not run.
- **shellcheck / actionlint:** not installed here; the workflow was validated by YAML parsing and by the Smoke run itself.
- **Windows/macOS/musl installs of `@node-rs/argon2`:** only linux-x64-gnu was exercised (locally and in CI).
- **Migration on a non-empty `refresh_token` table:** the backfill statement was not exercised with existing rows (every database it ran on was empty).

## 11. Open questions and where to look first

**For the owner's review, in this order:** `refreshTokens.ts` (`rotate`), `auth.service.ts` (`login`), `transport.ts` (`csrfGuard`), `accessTokens.ts` (`verify`), `middleware/auth.ts`.

1. **Q-04, email verification strictness:** may an unverified account log in? Today: yes. This drives the residual enumeration and the pre-registration risk in 4.1.
2. **Strict reuse on concurrent refresh** (4.3): keep, or accept a grace window?
3. **Per-account lockout policy:** 5 free attempts, 1 s doubling to a 15-minute cap. Acceptable balance between guessing and denial of service against a known address?
4. **Pepper:** use one? It must be decided before the first real user; changing it later invalidates all passwords.
5. **Where do the throttle and rate-limit counters live** once there is more than one instance (Postgres table or Redis)?
6. **Canonical `iss`/`aud`:** defaults are `akiba-api` / `akiba`; a deployment may want the public API URL as issuer.
7. **Should `logout-all` return 204 on a repeat** (deviation 5)?
8. **Smoke accounts** accumulate in any database the smoke runs against (deviation 7).

## 12. Carry-forward (also appended to docs/sprints/carry-forward.md)

- **T5:** send the "you already have an account" email on the `register_existing` path; send the verification email on register; password reset must call `AuthService.logoutAll(userId)`; new passwords at reset must go through `newPasswordSchema` and the `BreachedPasswordChecker`; reuse the `/v1/auth` limiter and CSRF guard for new routes.
- **T5 / Q-04:** decide what an unverified account may do.
- **T6:** never link an OAuth identity to an existing password account whose email is unverified; OAuth logins create sessions through `RefreshTokenStore.startFamily` + `AccessTokenService.issue` (same transport rules); OAuth-only accounts (`password_hash` NULL) already fail password login through the dummy-hash path.
- **T7/T10 (clients):** send `X-Client: web/<ver>` on every request; keep the access token in memory only; **single-flight the refresh across tabs**; web and API must be same-site; treat 401 `INVALID_REFRESH_TOKEN` as "signed out".
- **Every later module:** protect routes with the `authenticated` chain exported by `createAuthModule` and read the caller with `getAuth(res)`; never take a user ID from input; add IDOR tests per endpoint.
- **T11 / before launch:** replace the 180-entry password list with a real corpus or verify and enable the HIBP lookup; run `pnpm audit`; tune argon2 on the target hardware; independent review of the auth module; move throttle/limiter state to a shared store if more than one instance; add a job that deletes expired and long-revoked `refresh_token` rows; consider rehash-on-login when argon2 parameters are raised.
- **T17 (account deletion):** accounts with `deleted_at` set are already refused by login, refresh and `requireAuth`; restore within the grace period therefore needs its own authentication path.
- **Smoke:** `20-auth.sh` uses 9 of the 10 auth requests per minute per IP; a later auth smoke file must run against the same budget or use its own instance.
