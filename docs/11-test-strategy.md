# Test Strategy

**Version:** 1.0 · **Date:** 2026-11-15

## 1. Principles
1. Test behaviour and invariants, not implementation.
2. The riskiest parts get the deepest tests: **auth**, **ID mapping**, **event log/progress invariants**, **authorization (IDOR)**.
3. External APIs are never hit in CI — use recorded fixtures and contract tests.
4. Every FR has at least one test referencing its ID in the test name.
5. A milestone isn't done until its exit-criteria tests pass in CI.

## 2. Levels and tools
| Level | Scope | Tools |
|---|---|---|
| Unit | Pure logic: progress rules, status transitions, mapping resolution, token logic, validators | Vitest |
| Integration (API) | Routes + services + real PostgreSQL (disposable DB per run) | Vitest + Supertest, Testcontainers/Docker Postgres |
| Contract | Source adapters vs recorded AniList/Jikan responses; shared Zod schemas vs API responses | Vitest + saved fixtures (msw) |
| Component | React components and hooks | Vitest + React Testing Library |
| E2E (web) | Critical user journeys in a real browser | Playwright |
| Mobile | Component tests; smoke E2E on simulators | Jest/RNTL; Maestro (or Detox) |
| Desktop | Launch + sign-in smoke; security config assertions | Playwright for Electron |
| Accessibility | Automated + manual | axe-core in Playwright; keyboard walkthrough |
| Security | Auth abuse cases, header checks, dependency audit | Custom API tests, `npm audit`, secret scanning |
| Performance | Query plans, budgets | EXPLAIN checks on hot queries; Lighthouse CI on key pages |

## 3. Critical test suites

### 3.1 Authentication (blocks M1)
- Register/login/logout/reset happy paths and error equivalence (unknown vs wrong password).
- Refresh rotation; **reuse of an old refresh token revokes the family**; expired/idle tokens rejected.
- JWT: wrong alg, `none`, tampered signature, wrong `aud`/`iss`, expired → 401.
- OAuth: bad `state`, bad `nonce`, wrong `aud`, unverified email not auto-linked.
- Throttling after N failures; no user enumeration on forgot-password.
- Password policy and breached-password rejection.

### 3.2 Authorization / IDOR (blocks M3)
For every user-scoped endpoint: user B requesting/modifying user A's resource → 404 and no side effects. Generated from the route table so new routes can't skip it.

### 3.3 Akiba ID mapping (blocks M1)
- Same title from AniList and MAL resolves to one Akiba ID.
- Idempotent re-resolution; concurrent resolution of the same external ID creates one row.
- Dataset import adds cross-IDs; conflicting dataset rows go to `mapping_conflict`; overrides win.
- Merge script repoints entries and events without loss.
- Fixture set of tricky cases: split-cour seasons, movies vs. TV, recaps/specials, remakes, titles without MAL/AniList counterpart.

### 3.4 Tracking and history invariants (blocks M3)
- `0 ≤ progress ≤ effectiveTotal`; override raising/lowering behaviour; reset of override.
- Status transitions (e.g. first episode on Planned → Watching, final → suggest completed).
- Rewatch creates Run N+1 and keeps Run N; one open run only.
- Each state change writes exactly one matching Event in the same transaction (fault-injection test: failing event insert rolls back state).
- Events are immutable (no update/delete path exists; DB permission test).
- Export contains everything; export → data matches DB snapshot.

### 3.5 Airing and inbox (blocks M5)
- Fan-out creates one notification per user per episode; reruns are no-ops (idempotent).
- Only Watching entries with alerts enabled are notified; opt-outs respected.
- Advisory lock prevents double runs; time-zone rendering.

### 3.6 Source resilience (blocks M2)
Simulate AniList timeout/429/500: circuit breaker opens, fallback or stale cache served, `stale` flag set, library data unaffected (NFR-REL-001).

## 4. E2E journeys (Playwright)
1. Sign up → verify → log in → search → add to Watching → +1 ×3 → rate → see in history.
2. Rewatch a Completed title; verify both runs.
3. Override an episode total; reset it.
4. Create share link (limited scope) → open anonymously → confirm hidden fields → revoke → link dead.
5. Export JSON/CSV → validate shape.
6. Inbox: simulate aired episode → badge → mark read.
7. Theme (light/dark) and keyboard-only pass on Home, Library, Title.

## 5. Test data
Seed script creates a small catalog; fixtures recorded from real source responses (scrubbed, committed); factories for users/entries/events. No production data. Never commit real tokens.

## 6. CI pipeline (GitHub Actions)
Install (cached) → lint → typecheck → unit → integration (Postgres service) → contract → build all apps → Playwright (web) → audit. Required to be green before merge. Mobile/desktop jobs added at M6/M7.

## 7. Coverage and quality gates
- Lines ≥ 80% on `services/`, `auth/`, `mapping/`, `tracking/`; no gate on UI glue.
- Zero `any` in shared packages (lint rule), strict TS everywhere.
- Flaky test policy: quarantine within a day, fix before next milestone exit.

## 8. Manual acceptance
At each milestone exit, the owner runs a scripted checklist derived from the user stories (PRD §6) on real devices/browsers, plus an accessibility spot-check (keyboard only, 200% zoom, dark mode).

## 9. Traceability
Test names include requirement IDs, e.g. `FR-TRK-007 progress cannot exceed effective total`. A script greps IDs in `04-srs.md` vs. tests and reports uncovered MVP requirements at each milestone exit.
