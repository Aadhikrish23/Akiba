# Software Requirements Specification (SRS)

**Product:** Akiba · **Version:** 1.0 · **Date:** 2026-11-15 · Style: IEEE 830-inspired
Keywords: **shall** = mandatory, **should** = recommended, **may** = optional. "MVP" marks requirements needed by M1–M6.

## 1. Introduction
### 1.1 Purpose
Defines testable requirements for Akiba: backend API, web app, mobile app, and desktop wrapper.
### 1.2 Scope
Anime discovery, personal library, tracking, history, exploration and notifications. Excludes streaming, video hosting, social features, manga, production (Vision §9).
### 1.3 Definitions
See glossary in [README](00-README.md).
### 1.4 References
[Vision](01-vision.md), [PRD](03-prd.md), [Architecture](05-architecture.md), [Data model](06-data-model.md), [API](07-api-spec.md), [Security](09-security-privacy.md).

## 2. Overall description
### 2.1 Product perspective
Standalone system: Express API + PostgreSQL, three clients (React web, Expo mobile, Electron desktop wrapping web), consuming external metadata APIs.
### 2.2 User classes
Registered user (all features); anonymous visitor (public share-link view only; no browsing before login in MVP — see A-03).
### 2.3 Operating environment
Web: evergreen Chrome, Firefox, Safari, Edge. Mobile: iOS and Android via Expo. Desktop: Windows, macOS, Linux via Electron. Backend: Node.js LTS, PostgreSQL ≥ 15.
### 2.4 Constraints
- Free, non-commercial use; comply with source API terms and rate limits (NFR-COMP).
- Hand-rolled auth (D-07) → strict hardening (doc 09).
- TypeScript everywhere; monorepo.
### 2.5 Assumptions and dependencies
- **A-01** AniList API provides search, browse, relations, studios, characters, airing schedule.
- **A-02** A fallback source (default Jikan/MAL) is available for reads during AniList outages (Q-01).
- **A-03** Login is required to use the app; only share links are viewable anonymously.
- **A-04** An ID-mapping dataset is available (Q-02).

## 3. Functional requirements

### 3.1 Accounts and authentication (AUTH)
| ID | Requirement | Pri |
|---|---|---|
| FR-AUTH-001 | The system shall let a visitor register with email and password. | MVP |
| FR-AUTH-002 | The system shall let a user sign in with Google and with Apple, creating or linking an account. | MVP |
| FR-AUTH-003 | The system shall issue short-lived access tokens and rotating refresh tokens; refresh-token reuse shall revoke the token family. | MVP |
| FR-AUTH-004 | The system shall support logout (current device) and "log out everywhere". | MVP |
| FR-AUTH-005 | The system shall support password reset via emailed one-time link. | MVP |
| FR-AUTH-006 | The system shall verify email addresses. | MVP |
| FR-AUTH-007 | The system shall let a user link/unlink OAuth providers, never leaving an account with no sign-in method. | MVP |

### 3.2 Discover (DISC)
| ID | Requirement | Pri |
|---|---|---|
| FR-DISC-001 | The system shall provide text search over titles (romaji, English, native, synonyms). | MVP |
| FR-DISC-002 | The system shall provide filtered browsing by genre, tag, season, year, format, status and sort (popularity, score, start date). | MVP |
| FR-DISC-003 | The system shall provide a seasonal chart for the current and adjacent seasons. | MVP |
| FR-DISC-004 | The system shall display a title page: cover, titles, synopsis, format, episodes, status, season, studios, genres, relations, characters. | MVP |
| FR-DISC-005 | The system shall show related titles on the title page. | MVP |
| FR-DISC-006 | The system shall paginate all lists. | MVP |
| FR-DISC-007 | The system shall show the user's own library status on every title card/page. | MVP |
| FR-DISC-008 | The system shall resolve every external result to an Akiba ID before display or library use. | MVP |
| FR-DISC-009 | The system shall exclude non-anime/live-action items. | MVP |
| FR-DISC-010 | The system shall serve from cache and fall back to the secondary source when the primary is unavailable, labelling stale data. | MVP |

### 3.3 Collect — library (LIB)
| ID | Requirement | Pri |
|---|---|---|
| FR-LIB-001 | The system shall let a user add a title with status Watching, Completed, Planned, On hold or Dropped. | MVP |
| FR-LIB-002 | The system shall let a user change status and remove a title (removal preserves events). | MVP |
| FR-LIB-003 | The system shall list the library filterable by status, format, genre, rating, year and searchable by title. | MVP |
| FR-LIB-004 | The system shall offer poster-grid and compact-list layouts and remember the choice per user. | MVP |
| FR-LIB-005 | The system shall support sorting by recently updated, title, rating, progress and start date. | MVP |
| FR-LIB-006 | The system shall prevent duplicate library entries for one Akiba ID per user. | MVP |
| FR-LIB-007 | The system shall let a user mark/unmark favorites. | MVP |
| FR-LIB-008 | The system shall support notes/tags on an entry. | Later |

### 3.4 Track (TRK)
| ID | Requirement | Pri |
|---|---|---|
| FR-TRK-001 | The system shall store progress as an integer count of episodes watched (0…total). | MVP |
| FR-TRK-002 | The system shall let a user increment by 1 or set an absolute number. | MVP |
| FR-TRK-003 | When progress equals the total, the system shall offer to mark the entry Completed and record finish date. | MVP |
| FR-TRK-004 | When the first episode is logged on a Planned entry, the system shall move it to Watching and record a start date. | MVP |
| FR-TRK-005 | The system shall use the source's episode total and airing schedule and shall let the user override the total; override is visible and resettable. | MVP |
| FR-TRK-006 | The system shall display next-airing time for airing titles in the user's time zone. | MVP |
| FR-TRK-007 | Progress shall not exceed a known total (overridden or source) unless the user raises the override. | MVP |
| FR-TRK-008 | Every progress change shall append an Event. | MVP |

### 3.5 Remember (REM)
| ID | Requirement | Pri |
|---|---|---|
| FR-REM-001 | The system shall let a user rate a title on a 1–10 scale (clearable). | MVP |
| FR-REM-002 | The system shall let a user write, edit and delete a private text review per entry. | MVP |
| FR-REM-003 | The system shall provide a chronological history timeline derived from Events with filters (title, type, date). | MVP |
| FR-REM-004 | The system shall support rewatch: starting a new Run for a Completed title, preserving prior Runs and dates. | MVP |
| FR-REM-005 | The system shall show per-title run history (start, finish, rating per run optional). | MVP |
| FR-REM-006 | The system shall show basic stats (counts by status, episodes watched, average rating, per-year activity). | Later |
| FR-REM-007 | Events shall be append-only; corrections create compensating events. | MVP |

### 3.6 Explore (EXP)
| ID | Requirement | Pri |
|---|---|---|
| FR-EXP-001 | The system shall display a franchise view grouping a title with all related titles by relation type. | MVP |
| FR-EXP-002 | The system shall show the user's status on each franchise entry. | MVP |
| FR-EXP-003 | The system shall provide a studio page listing studio works. | MVP |
| FR-EXP-004 | The system shall provide a character page listing appearances and voice actors. | MVP |
| FR-EXP-005 | The system should suggest a watch order for a franchise (release or chronological where data allows). | Later |

### 3.7 Notifications (NOTE)
| ID | Requirement | Pri |
|---|---|---|
| FR-NOTE-001 | The system shall create an Inbox item when a new episode of an entry in Watching airs. | MVP |
| FR-NOTE-002 | Inbox items shall be unique per user per episode. | MVP |
| FR-NOTE-003 | The system shall list, mark read, mark all read and delete Inbox items, and show an unread count. | MVP |
| FR-NOTE-004 | A user shall be able to disable alerts per entry or globally. | MVP |
| FR-NOTE-005 | The system shall not send push or email notifications. | MVP constraint |

### 3.8 Export, sharing, account (EXPT / SHARE / ACCT)
| ID | Requirement | Pri |
|---|---|---|
| FR-EXPT-001 | The system shall export all user data as JSON and library data as CSV. | MVP |
| FR-EXPT-002 | Export shall be reimportable by Akiba's own format (import UI is post-MVP). | MVP |
| FR-SHARE-001 | The system shall let a verified user create one read-only share link (unguessable token) exposing selected scope (library statuses, ratings yes/no, reviews yes/no). | MVP |
| FR-SHARE-002 | The user shall be able to revoke/regenerate the link; revocation is immediate. | MVP |
| FR-SHARE-003 | Shared view shall not expose email, account ID, events or non-selected data. | MVP |
| FR-ACCT-001 | The system shall let a user edit profile settings (display name, title-language preference, time zone). | MVP |
| FR-ACCT-002 | The system shall let a user delete their account; data is hard-deleted after the grace period. | MVP |

## 4. External interface requirements
- **UI:** per [UX design](08-ux-design.md); responsive 360 px → 1920 px.
- **API:** REST/JSON over HTTPS per [API spec](07-api-spec.md); versioned under `/v1`.
- **Sources:** AniList GraphQL (primary), Jikan REST (fallback), mapping dataset import job.
- **OAuth providers:** Google, Apple (OIDC).
- **Email:** transactional email provider for verification/reset (provider TBD, abstracted behind an interface).

## 5. Non-functional requirements
| ID | Requirement |
|---|---|
| NFR-PERF-001 | p95 API response ≤ 300 ms for library/read endpoints served from DB/cache (local/standard instance). |
| NFR-PERF-002 | p95 search/browse response ≤ 800 ms with warm cache; ≤ 2 s on cache miss. |
| NFR-PERF-003 | +1 episode shall reflect in UI optimistically in < 100 ms and persist within 1 s. |
| NFR-PERF-004 | Web LCP ≤ 2.5 s on a mid-range laptop on broadband; library page of 500 entries remains scrollable at 60 fps (virtualised list/grid). |
| NFR-SEC-001 | Passwords hashed with argon2id; no plaintext or reversible storage. |
| NFR-SEC-002 | All traffic over TLS outside local dev; HSTS; secure cookies. |
| NFR-SEC-003 | OWASP ASVS L2 controls relevant to auth, session, access control and input validation are met (doc 09). |
| NFR-SEC-004 | Per-user authorization on every library/event/inbox query (no IDOR). |
| NFR-SEC-005 | Rate limiting on auth, search proxy and write endpoints. |
| NFR-PRIV-001 | Data private by default; no third-party trackers or ad SDKs. |
| NFR-PRIV-002 | Complete export and deletion available to every user. |
| NFR-A11Y-001 | WCAG 2.2 AA: contrast, keyboard operation, visible focus, labelled controls, reduced-motion respected. |
| NFR-A11Y-002 | Light and dark themes follow system preference. |
| NFR-REL-001 | Library and event data are never lost on source outage; app degrades to cached metadata. |
| NFR-REL-002 | Database migrations are versioned and reversible where feasible; daily backup is a deployment-phase requirement. |
| NFR-REL-003 | Scheduled jobs are idempotent and safe to retry. |
| NFR-MNT-001 | TypeScript strict mode; shared types from one package; lint + typecheck clean in CI. |
| NFR-MNT-002 | Automated tests per [test strategy](11-test-strategy.md); critical paths ≥ 80% coverage. |
| NFR-MNT-003 | Source adapters sit behind an interface so a source can be replaced. |
| NFR-COMP-001 | Respect AniList/Jikan rate limits and terms; cache responses; show attribution as required. |
| NFR-COMP-002 | Do not store or serve copyrighted video; cover art only via the sources' permitted URLs. |
| NFR-LOC-001 | UI English at MVP; strings externalised for later localisation. |

## 6. Data requirements (summary)
Entities and constraints are defined in [doc 06](06-data-model.md). Key invariants: unique (user, title) entry; Events immutable; progress ≤ effective total; one active share link per user.

## 7. Requirement traceability
| PRD story | Requirements |
|---|---|
| US-01 | FR-AUTH-001…007 |
| US-02 | FR-EXPT-001/002, FR-ACCT-002 |
| US-03/04/05 | FR-DISC-001…010 |
| US-06/07/10 | FR-LIB-001…007 |
| US-08/09 | FR-TRK-001…008 |
| US-11/12 | FR-REM-001…007 |
| US-13 | FR-SHARE-001…003 |
| US-14/15 | FR-EXP-001…004 |
| US-16 | FR-NOTE-001…005 |

## 8. Out of scope for this SRS version
Recommendations, import, push/email, deployment and infrastructure.
