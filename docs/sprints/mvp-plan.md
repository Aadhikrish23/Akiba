# MVP Plan — M2 to M6 (tasks T12–T29)

M1 (T1–T11) is in [sprint-01.md](sprint-01.md). Roadmap context: [10-roadmap.md](../10-roadmap.md).

## Process for this run (changed 2026-11-16 by the product owner)
- **Fable developer agents only**, one at a time, one task each, in task order.
- **No reviewer, tester or analyst agents; no PRs or merges.** Each developer commits to the base branch `ccr-0014c7e1-32mc28` and pushes it. Module-wise analysis happens afterwards.
- Developers still write and run their own tests and must check CI on the pushed commit and fix forward.
- Each developer writes a full report to `research/fable-study/dev-reports/T<n>-<slug>.md` and returns a short summary.
- The coordinator appends to `research/fable-study/decision-log.md` and updates the status columns below.
- Same global rules as sprint 1: follow the docs, no secrets, never skip/weaken a test, no live external API calls in CI (use recorded fixtures), requirement IDs in test names.

## M2 — Search & browse (web)
| # | Slug | Task | Done when | Status |
|---|---|---|---|---|
| T12 | `titles-read-api` | Endpoints from doc 07 §3: `/titles/search`, `/titles/browse`, `/seasons/current`, `/seasons/:year/:season`, `/titles/:titleId`, `/genres`. Use the adapters + Akiba ID resolver + `title` cache; stale/fallback with `meta.stale`/`source`; exclude non-anime; adult entries hidden by default (Q-10); cursor pagination; user's `libraryStatus` field (null until M3) | FR-DISC-001…010 covered by integration tests on fixtures; breaker/outage path serves stale cache | **done** (2026-11-18, not yet pushed) — `apps/api/src/modules/titles/`: search, browse, seasons (current + named), detail, relations, genres, all authenticated; list reuse cache (5 min), detail TTL (6 h live / 7 d finished), fallback to Jikan then to the stored catalog (`meta.stale`), 503 only when nothing is stored; adult hidden (Q-10); `libraryStatus` already wired (library_entry join); sources config in env; `/ready` reports sources `ok`/`degraded`. 41 + 5 tests on real PostgreSQL with fake source networks. New column `title.detail_fetched_at`. No review/test stage |
| T13 | `web-discover` | Web "Shelf" app shell per docs/08 and `docs/mockups/shelf.html`: sidebar/top nav, poster card, search, browse filters, seasonal chart, title detail page; loading/empty/error/stale states; light/dark | Component tests + axe-core clean; Playwright: search → open title; filters combine | pending |
| T14 | `m2-verify` | Playwright journeys for discovery; perf check of NFR-PERF-002 on fixture data; fix gaps | Journeys green in CI | pending |

## M3 — Library, progress, remember
| # | Slug | Task | Done when | Status |
|---|---|---|---|---|
| T15 | `library-api` | `/library` CRUD, statuses, duplicate prevention (409), favorites, filters/sorts/search, soft-remove keeping events; every state change + `event` in ONE transaction; `libraryStatus` wired into title responses | FR-LIB-001…007 tests; fault-injection test: failing event insert rolls back | pending |
| T16 | `tracking-api` | Progress `+1`/`set`, completion suggestion, Planned→Watching on first episode, episode-total override/reset, effective total invariant, ratings, reviews, rewatch runs (one open run), `/history` timeline | FR-TRK-001…008, FR-REM-001…005,007 tests incl. invariants | pending |
| T17 | `account-api` | `/me` profile/settings, JSON/CSV export, share link (create/regenerate/revoke, scoped public `/shared/:token`), account delete + restore, cleanup job (14-day grace) | FR-EXPT, FR-SHARE, FR-ACCT tests; public view exposes no PII | pending |
| T18 | `web-library` | Library page (grid/list toggle, status tabs, filters), Home "Continue watching" with +1 (optimistic), add-to-library on title page, rate/review/favorite, rewatch, History page | Component + Playwright journeys 1–3 from doc 11 §4 | pending |
| T19 | `web-account` | Settings (profile, theme, title language, adult toggle), export, share-link UI, delete account, public shared-list page | Playwright journeys 4–5 | pending |
| T20 | `m3-verify` | Generated IDOR suite from the route table (user B vs user A → 404), invariant/fault-injection tests, export snapshot test, fix gaps | doc 11 §3.2/§3.4 suites green | pending |

## M4 — Explore
| # | Slug | Task | Done when | Status |
|---|---|---|---|---|
| T21 | `explore-api` | Relations ingestion, franchise computation (connected components over allowed relation types, size cap), `/titles/:id/relations`, `/franchises/:id`, studios, characters endpoints with user status | FR-EXP-001…004 tests; curated long-franchise fixture groups correctly | pending |
| T22 | `web-explore` | Franchise view (status per entry), studio page, character page, relations on title page | Playwright + axe | pending |

## M5 — Airing inbox
| # | Slug | Task | Done when | Status |
|---|---|---|---|---|
| T23 | `airing-api` | airing-sync job, inbox fan-out (idempotent, unique per user+episode, respects alert settings), `/inbox` endpoints, scheduler with advisory locks, account-cleanup + metadata-refresh jobs wired | FR-NOTE-001…005 tests incl. rerun idempotency and lock | pending |
| T24 | `web-inbox` | Inbox page, unread badge, per-entry/global alerts, next-airing times in user's time zone | Playwright journey 6 | pending |

## M6 — Mobile (Expo)
| # | Slug | Task | Done when | Status |
|---|---|---|---|---|
| T25 | `mobile-foundation` | `apps/mobile` Expo + TypeScript, navigation (tabs per doc 08), tokens from `ui-tokens`, shared `api-client`, auth with SecureStore, light/dark | Typecheck/lint/tests in CI; app boots via Expo (web/export or simulator if available) | pending |
| T26 | `mobile-discover` | Home, Discover (search/browse/season), Title detail | Component tests; a11y labels; 44-px targets | pending |
| T27 | `mobile-library` | Library grid/list, +1, status/rate/review/favorite/rewatch, history | Component tests | pending |
| T28 | `mobile-inbox-settings` | Inbox, settings, export/share/delete, Google/Apple sign-in on device | Component tests; fake OIDC verifier path | pending |
| T29 | `mvp-hardening` | Run doc 09 §9 checklist, update docs status (verified vs unverified), README, remove dead code, full CI + smoke green | Checklist done or gaps documented | pending |
