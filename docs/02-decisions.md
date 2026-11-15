# Decision Log

**Version:** 1.0 · **Date:** 2026-11-15 · Source: product grilling session between the product owner and Claude (builder).

Operating model: the product owner supervises and approves milestones; Claude implements.

## 1. Decisions (accepted)

| ID | Area | Decision | Rationale |
|---|---|---|---|
| D-01 | Metadata | Third-party APIs are the source of truth for anime metadata. | Fastest path; discovery and explore depend on rich data. |
| D-02 | Metadata | **AniList (GraphQL)** is the primary source; **a fallback source is used when AniList is unavailable** (see Q-01). | Best relations graph, schedules and recommendations; resilience. |
| D-03 | Identity | Every Title has an internal **Akiba ID**; a mapping table links it to AniList / MAL / Kitsu IDs. Library entries reference only the Akiba ID. | Sources can fail or be swapped without breaking user libraries. |
| D-04 | Platforms | Web, mobile and desktop. Delivery order: **web → mobile → desktop**. | Core loop proven on one client first. |
| D-05 | Stack — backend | Node.js + Express + TypeScript. | Owner preference. |
| D-06 | Stack — data | PostgreSQL + Prisma. | Typed queries and migrations. |
| D-07 | Stack — auth | Hand-rolled JWT auth: email+password, Google and Apple sign-in. Auth module kept replaceable. | Owner chose full control; vendor lock-in avoided. See doc 09 for hardening requirements. |
| D-08 | Stack — web | React + Tailwind CSS + TypeScript (Vite). | Owner preference. |
| D-09 | Stack — mobile | React Native with Expo (Expo Go for dev). | Owner preference. |
| D-10 | Stack — desktop | Electron wrapping the web app; last milestone. | Minimal extra code. |
| D-11 | Repo | TypeScript monorepo with shared packages (types, API client, validation). | Four clients share contracts. |
| D-12 | Ownership | Cloud accounts with full **JSON/CSV export** as a first-class feature. | Delivers "personal ownership and control" without local-first sync complexity. |
| D-13 | Privacy | Everything private by default. Optional **read-only share link** per user list. No follows, feeds or comments. | Stays outside social-network non-goal. |
| D-14 | Tracking | Progress stored as episodes watched. Episode totals/airing from API with **manual user override**. | Handles source disagreement and long-runners. |
| D-15 | History | **Append-only event log**; rewatches are new Runs. | Enables timeline and stats; history cannot be reconstructed later. |
| D-16 | Notifications | **In-app inbox only** (no push/email) for new-episode alerts. | Removes push infrastructure from MVP. |
| D-17 | Recommendations | **Post-MVP.** Method undecided (candidate: source recs re-ranked by user taste). | Needs ratings data first. |
| D-18 | Import | MAL/AniList list import is **post-MVP**. Export is in MVP. | Scope control. |
| D-19 | Commercial | Free, non-commercial. | Matches source-API terms and personal-first stance. |
| D-20 | Yume | Fully separate from Gekijou/Yume; auth swappable for future SSO. | Vision §11. |
| D-21 | Analytics | Minimal, privacy-first: aggregate counts from own DB + error logging; no third-party trackers. | Ownership principle. |
| D-22 | Design | **"Shelf"** direction: poster-forward, warm paper/ink, vermilion accent; compact list view for tracking. Mockup: `docs/mockups/shelf.html`. | Approved by owner. Explicitly no generic AI-style UI. |
| D-23 | Sequencing | Milestones: M1 foundation → M2 search/browse → M3 library/progress/ratings → M4 relations/studios/characters → M5 airing inbox → M6 mobile → M7 desktop. | See doc 10. |
| D-24 | Hosting | Deployment, hosting and budget are **deferred** until after the build. | Owner decision. |

## 2. Parked (explicitly out of the build for now)
Recommendation engine · MAL/AniList import · push/email notifications · deployment & infrastructure · local-first/offline sync · public profiles.

## 3. Out of scope forever (non-goals from Vision §9)
Streaming, video hosting, social network, manga reader, production platform.

## 4. Open questions

| ID | Question | Needed by | Default assumption until answered |
|---|---|---|---|
| Q-01 | Which source is the fallback — Jikan (MAL) or Kitsu? | M1 | **Jikan (MAL)**, because MAL IDs are well-mapped. |
| Q-02 | Which ID-mapping dataset? | M1 | Community dataset (e.g. Fribb/anime-lists) refreshed on a schedule, plus manual overrides. |
| Q-03 | Is a review attached to the library entry or to each Run? | M3 | One rating + review per **library entry**; optional per-Run rating. |
| Q-04 | Password policy and email verification strictness. | M1 | Min 10 chars, breached-password check, email verification required before share links. |
| Q-05 | Recommendation method. | Post-MVP | Re-rank source recommendations by user ratings/genres. |
| Q-06 | Cover-image strategy: hotlink vs proxy/cache. | M2 | Hotlink source CDN URLs; revisit if terms or reliability require proxying. |
| Q-07 | Languages: UI in English only? Title display preference (romaji/English/native)? | M2 | English UI; per-user title-language preference (romaji default). |
| Q-08 | Account recovery method (email reset only?). | M1 | Email reset link. |
| Q-09 | Is hard account deletion immediate or after a grace period? | M3 | 14-day grace period, then hard delete. |
| Q-10 | Default handling of adult/mature catalog entries. | M2 | Hidden by default; user can enable in Settings. |

## 5. Change process
Decisions change only by appending a new row that supersedes the old (`Supersedes D-xx`), approved by the product owner.
