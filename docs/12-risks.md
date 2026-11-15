# Risk Register

**Version:** 1.0 · **Date:** 2026-11-15 · Scale: Likelihood (L) and Impact (I) 1–5; score = L×I. Review at every milestone exit.

| ID | Risk | L | I | Score | Mitigation | Owner | Trigger / early warning |
|---|---|---|---|---|---|---|---|
| R-01 | **ID mapping errors** (wrong or duplicate Akiba IDs) corrupt libraries or franchises | 4 | 5 | **20** | Mapping dataset + manual overrides, conflict queue, fixture test set, merge script, event log keeps history intact | Builder | Conflict-queue growth; user reports of wrong title |
| R-02 | **Hand-rolled auth vulnerability** | 3 | 5 | **15** | Doc 09 checklist, argon2id, rotation + reuse detection, abuse-case tests, owner review before M1 exit, replaceable module | Builder + Owner | Failed security tests; audit findings |
| R-03 | **Scope too large** (5 pillars × 4 clients) | 4 | 4 | **16** | Strict milestone order; desktop wraps web; recs/import/push deferred; shared packages; per-milestone sign-off | Owner | A milestone exceeds its plan twice in a row |
| R-04 | **AniList outage, rate limits or API change** | 3 | 4 | 12 | Caching, circuit breaker, fallback source, adapter interface, stale labelling, request coalescing | Builder | 429/5xx rate; schema validation failures |
| R-05 | **API terms/licensing restrict use** (non-commercial only; art/metadata rights) | 3 | 4 | 12 | Stay free/non-commercial (D-19); attribution; no art re-hosting; legal re-check before any monetisation or public launch | Owner | Terms change; plan to charge |
| R-06 | **Episode-count/airing data disagree or are wrong** | 4 | 3 | 12 | Manual override (D-14), source precedence rules, "edited" badge, tolerant progress logic | Builder | Corrections per 100 entries (PRD metric) |
| R-07 | **Four-client maintenance burden** | 3 | 3 | 9 | Shared types/client/tokens, no logic duplication, Electron = thin wrapper, contract tests | Builder | Behaviour drift between clients |
| R-08 | **Event log / state divergence** | 2 | 4 | 8 | Single transaction for state + event, invariants tests, fault injection, reconcile script | Builder | Test failures; mismatch checks |
| R-09 | **Franchise graph inaccuracies** (wrong grouping, huge components) | 3 | 3 | 9 | Derive from relation types with exclusions (e.g. ignore "other"/"character" links for grouping), curated test cases, cap and paginate | Builder | Oversized franchises |
| R-10 | **Generic-looking UI ("AI slop") creeps in** | 2 | 3 | 6 | Design tokens, approved mockup, anti-pattern list, design review each milestone | Owner | Review findings |
| R-11 | **Apple/Google sign-in setup friction** (developer accounts, review rules) | 3 | 2 | 6 | Email login ships first; Apple sign-in required on iOS if other social logins are offered — plan accounts early | Owner | Account/enrolment delays |
| R-12 | **Cold start for existing fans (no import)** | 4 | 2 | 8 | Import first in post-MVP backlog; export format designed as an import-compatible shape | Owner | Low onboarding completion |
| R-13 | **In-app-only alerts are missed** | 3 | 2 | 6 | Prominent unread badge; push/email in post-MVP backlog | Owner | Low inbox open rate |
| R-14 | **Electron security** | 2 | 4 | 8 | Hardening checklist, no node integration, strict CSP, restricted IPC | Builder | Checklist failures |
| R-15 | **Data loss before deployment decisions** (no backups defined) | 2 | 5 | 10 | Local dev only until deployment phase; backups/restore drills are a gate for any real-user launch | Owner | Planning to host real users before the deployment phase completes |
| R-16 | **Adult/mature content handling** | 2 | 3 | 6 | `is_adult` hidden by default; decide policy (Q-10) | Owner | Source returns mature items in browse |
| R-17 | **Open questions block work** | 3 | 2 | 6 | Defaults recorded in Decisions §4; resolve before the needing milestone | Owner | Milestone starts with unresolved Q |

## Top risks to watch first
R-01 (mapping), R-03 (scope), R-02 (auth), R-04/05 (sources).

## Review log
| Date | Reviewer | Notes |
|---|---|---|
| 2026-11-15 | Initial | Register created with doc set v1.0 |
