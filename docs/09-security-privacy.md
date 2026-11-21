# Security & Privacy

**Version:** 1.0 · **Date:** 2026-11-15 · Hand-rolled auth (D-07) means this document is binding for implementation and review. Target: OWASP ASVS L2 for the relevant sections.

## 1. Assets and actors
**Assets:** credentials/tokens, personal library, reviews and history, email addresses, share links.
**Actors:** anonymous attacker, authenticated malicious user (IDOR), stolen device/session, compromised third-party source (untrusted data), curious visitor with a share link.

## 2. Authentication requirements
| # | Requirement |
|---|---|
| S-AUTH-1 | Passwords hashed with **argon2id** (memory ≥ 19 MiB, t ≥ 2, p = 1 as a floor; tuned on target hardware); per-hash salt; optional pepper from env. |
| S-AUTH-2 | Password policy: min 10 chars, max 128, no composition rules; reject known-breached passwords (k-anonymity range lookup or a local list); no truncation. |
| S-AUTH-3 | Login errors identical for unknown email and wrong password; constant-time comparison; dummy hash on unknown user. |
| S-AUTH-4 | Brute-force protection: per-IP and per-account throttling with exponential backoff; no permanent lockout (avoid DoS). |
| S-AUTH-5 | Access token: JWT, **15 min**, algorithm pinned (EdDSA preferred; if HS256, ≥ 256-bit secret), `iss`/`aud`/`exp`/`sub`/`sid` validated; no sensitive data in claims; keys rotatable via `kid`. |
| S-AUTH-6 | Refresh token: opaque 256-bit random, **stored hashed**, **rotated on every use**, family tracking; reuse of a rotated token revokes the entire family; absolute lifetime 30 days, idle 14 days. |
| S-AUTH-7 | Web: refresh token in `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth` cookie; access token held in memory only (never `localStorage`). CSRF defence for cookie-authenticated endpoints (SameSite + custom header check + Origin validation). |
| S-AUTH-8 | Mobile: tokens in Expo SecureStore (Keychain/Keystore). Desktop: same as web in an isolated renderer. |
| S-AUTH-9 | OAuth: authorization-code + PKCE; `state` and `nonce` validated; Google/Apple ID tokens verified against JWKS (`iss`, `aud`, `exp`, `nonce`); link by verified email only when the provider asserts `email_verified`; never auto-merge on unverified email. Apple private-relay emails supported. |
| S-AUTH-10 | Email verification and reset use single-use random tokens (≥ 128-bit), hashed at rest, expiry 1 h (reset) / 24 h (verify); reset revokes all sessions. |
| S-AUTH-11 | Password change and email change require recent re-authentication; notify the old email. |
| S-AUTH-12 | Auth module isolated behind an interface so a managed provider/SSO can replace it (D-07, D-20). |

## 3. Authorization
- Every query on user-owned tables is scoped by `user_id` from the verified token — **never** from request input (SEC-004). Repository helpers require `userId` as a parameter; there is no unscoped accessor for user tables.
- Unknown and not-owned resources both return 404.
- Automated IDOR tests per endpoint (see [test strategy](11-test-strategy.md)).
- Share-link views use a separate read-only code path returning an explicit allow-listed projection.

## 4. Input, output and transport
- Validate every request body, query and path param with Zod; reject unknown fields on writes; max body 100 KB (export/import excepted).
- Prisma parameterised queries only; no string-built SQL; raw queries require review.
- Output encoding handled by React; `dangerouslySetInnerHTML` banned (lint rule). Reviews and notes are plain text; synopsis from sources is sanitised (allow-list) before render.
- Security headers via helmet: strict CSP (no inline script except hashed), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Frame-Ancestors 'none'`, HSTS.
- CORS allow-list of known client origins; credentials only for those.
- TLS everywhere outside local dev (deployment phase).

## 5. Third-party and supply chain
- Source responses are untrusted: validate against schemas, bound sizes, never execute/interpolate content, cap redirects, use timeouts.
- Image URLs are used only as `img src` with `referrerpolicy="no-referrer"`; no server-side fetching of arbitrary user-supplied URLs (no SSRF surface).
- Pin dependencies with a lockfile; run `npm audit`/dependency review in CI; minimal dependency policy for auth code; Dependabot-style updates.
- Secrets only in environment variables; `.env` ignored; secret scanning in CI.

## 6. Share links
- Token ≥ 128-bit random, stored hashed; only the creator sees the raw token once.
- Scope explicit and minimal; default scope = statuses only (no reviews, no ratings).
- Public endpoint rate-limited; `X-Robots-Tag: noindex`; no email/ID/events exposed; revocation immediate.
- Requires verified email (Q-04).

## 7. Privacy
| Topic | Requirement |
|---|---|
| Data minimisation | Collect email, display name and what the user enters. No tracking pixels, ad SDKs or third-party analytics (D-21). |
| Purpose | Data used only to operate the product; never sold or shared. |
| Analytics | Aggregate counts from own DB; no per-user behavioural profiling beyond what the product needs. |
| Logs | No passwords, tokens, reviews or full emails in logs; request IDs only. |
| Access & portability | JSON/CSV export (FR-EXPT). |
| Erasure | Account deletion with 14-day grace then hard delete incl. events, tokens, share link (FR-ACCT-002); backups purge on rotation (deployment phase). |
| Children | Not targeted; a minimum-age statement (13+) in terms; `is_adult` catalog flag hidden by default behind a user setting (Q-10 to decide default). |
| Policies | A short privacy policy and terms are required before any public launch (deployment phase). |

## 8. Threat model (STRIDE summary)
| Threat | Example | Mitigation |
|---|---|---|
| Spoofing | Credential stuffing | Throttling, breached-password check, argon2id, generic errors |
| Tampering | Modify another user's entry | Server-side `userId` scoping, IDOR tests |
| Repudiation | Disputed data change | Immutable event log, request IDs |
| Information disclosure | Token theft via XSS | In-memory access token, HttpOnly refresh cookie, CSP, no raw HTML |
| Information disclosure | Share-link guessing / over-exposure | 128-bit token, allow-listed projection, noindex, revoke |
| Denial of service | Search/refresh flooding, upstream exhaustion | Rate limits, caching, coalescing, circuit breaker, body-size caps |
| Elevation of privilege | Refresh-token replay | Rotation + reuse detection |
| Supply chain | Malicious dependency | Lockfile, audit, review of auth deps |
| Electron-specific | Renderer compromise → OS access | `contextIsolation`, no node integration, sandbox, CSP, restricted IPC, `will-navigate` allow-list |

## 9. Security checklist (gate for M1 and each release)
- [x] argon2id params verified; unit tests for hashing and policy (not yet tuned on target hardware)
- [x] Token rotation + reuse-detection test passes
- [x] No endpoint returns another user's data: the access-control suite is generated from the route table (T20; every private route 401 without a token, every entry/notification ID route 404 for another user with nothing changed, an unclassified route or path parameter fails the build)
- [x] Rate limits active on auth and writes (per process)
- [x] CSP/headers verified; no `localStorage` tokens; cookies flags correct (web host must add frame-ancestors/HSTS at deployment)
- [ ] OAuth state/nonce/PKCE tests — deferred: separate auth module
- [ ] Logs reviewed for secrets/PII — asserted by tests; no human review yet
- [x] Dependency audit clean or exceptions documented (see sprints/m1-status.md). 2026-11-19: `pnpm audit --prod` reports one moderate finding, `minimatch` (DoS through glob amplification) under `expo > @expo/fingerprint`, which is developer tooling that never ships in the app bundle; accepted until Expo updates it
- [ ] Electron hardening checklist (M7)
- [ ] Independent code review of the auth module by the product owner/reviewer before M1 sign-off

## 10. Open items
Q-04 (email verification strictness), Q-08 (recovery), Q-09 (grace), Q-10 (adult-content default). Incident-response process is defined in the deployment phase.
