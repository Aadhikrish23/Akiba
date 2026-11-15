# Product Requirements Document (PRD)

**Product:** Akiba (秋葉) · **Version:** 1.0 · **Date:** 2026-11-15 · **Owner:** Product owner · **Builder:** Claude
Aligned to: [Vision v1.0](01-vision.md), [Decisions](02-decisions.md)

## 1. Problem statement
Anime fans keep their history scattered across spreadsheets, notes, streaming-service lists and big databases that feel impersonal. They lack one place that makes discovery easy, tracks what they are watching accurately, and preserves their personal history over years — while keeping the data theirs.

## 2. Goals and non-goals
**Goals**
1. Make finding the next anime effortless (search, browse, seasonal charts, related titles).
2. Make keeping a library and tracking episodes take seconds, not minutes.
3. Preserve a durable personal record: ratings, reviews, favorites and a true timeline including rewatches.
4. Let users explore franchises, studios and characters.
5. Give users ownership: private by default, complete export.

**Non-goals** (Vision §9): streaming, video hosting, social network, manga reading, production tooling.
**Also out of MVP:** recommendation engine, list import, push/email notifications, deployment (see Decisions §2).

## 3. Users
| Persona | Description | Key needs |
|---|---|---|
| **Primary — the Collector** (the product owner first) | Watches regularly, keeps a long-term list, cares about ratings and history. | Fast +1 tracking, reliable library, export, a timeline. |
| **Seasonal Watcher** | Follows several airing shows each season. | Seasonal chart, "what aired", inbox alerts. |
| **Explorer** | Chases franchises, studios, directors' work. | Relations, watch order, studio and character pages. |

Product begins personal-use, designed for a broader audience (multi-user from day one, with accounts).

## 4. Product pillars → capabilities
| Pillar | MVP capabilities |
|---|---|
| Discover | Search; browse by genre/season/year/format/popularity; related titles |
| Collect | Library with statuses (Watching, Completed, Planned, Dropped, On hold); grid & list views |
| Track | Episode progress (+1, set N), manual episode-total override, airing info, Inbox alerts for new episodes |
| Remember | Ratings, reviews, favorites, viewing history timeline with rewatches |
| Explore | Franchise/relations view, studio pages, character pages, seasons/movies/related works |

## 5. Scope and phasing
**MVP = M1–M6** (web, then mobile). **Desktop (M7)** ships after MVP. Details in [Roadmap](10-roadmap.md).

| Release | Contents |
|---|---|
| v0.1 (web) | Accounts, search/browse, library, progress, ratings/reviews/favorites, history, export, share link |
| v0.2 (web) | Franchise/relations, studios, characters, seasonal chart |
| v0.3 (web) | Airing inbox |
| v0.4 (mobile) | Expo app with the same core loop |
| v0.5 (desktop) | Electron wrapper |
| Post-MVP | Recommendations, MAL/AniList import, push/email, deployment hardening |

## 5.1 Media scope
Anime TV, movies, OVA, ONA, specials, franchise entries. Live-action, general cinema, non-anime documentaries are excluded; non-anime items returned by a source are filtered out (FR-DISC-009).

## 6. User stories and acceptance criteria

### Accounts
- **US-01** As a visitor I can sign up and log in with email or Google/Apple so my library follows me across devices.
  *AC:* Sign-up, login, logout, password reset work; Google and Apple sign-in create or link an account; sessions persist across app restarts.
- **US-02** As a user I can export all my data and delete my account.
  *AC:* Export yields JSON and CSV containing library, ratings, reviews, favorites and events; deletion removes personal data after the grace period.

### Discover
- **US-03** As a user I can search titles and see results quickly with cover, format, year and status.
  *AC:* Typing returns results; selecting opens the title page; no live-action results.
- **US-04** As a user I can browse by genre, season/year, format and popularity.
  *AC:* Filters combine; results paginate; current season is one click away.
- **US-05** As a user I see related titles on a title page.

### Collect & Track
- **US-06** As a user I can add a title to my library with a status.
- **US-07** As a user I can move a title between statuses and remove it.
- **US-08** As a user I can mark +1 episode in one tap from home, library or title page.
  *AC:* Progress updates immediately; reaching the last episode offers "mark completed".
- **US-09** As a user I can correct a title's episode total when the source is wrong.
  *AC:* Override persists, is shown as overridden and can be reset to source value.
- **US-10** As a user I can switch the library between poster grid and compact list.

### Remember
- **US-11** As a user I can rate a title (1–10), write a private review and mark favorites.
- **US-12** As a user I can see a timeline of my activity and rewatch a completed title as a new Run.
  *AC:* Rewatch preserves previous Run and its dates.
- **US-13** As a user I can create/revoke a read-only share link for my list.

### Explore
- **US-14** As a user I can view a franchise graph/list (prequel, sequel, side story, etc.) with my status on each entry.
- **US-15** As a user I can open studio and character pages and see their works.

### Notifications
- **US-16** As a user I get an Inbox item when a new episode of a title I'm watching airs.
  *AC:* One item per episode; mark read; items link to the title.

## 7. UX principles
Poster-forward, calm, fast. "Shelf" direction (see [UX design](08-ux-design.md)): paper/ink palette with a single vermilion accent, serif titles, tabular numerals. No generic AI-style UI (gradient-heavy hero, glass cards, shadow stacks, emoji icons).

## 8. Success metrics (privacy-first, own-DB counts)
| Vision criterion | Metric | Target (first 90 days after v0.3) |
|---|---|---|
| Discovery usefulness | % of searches leading to a title view or add | ≥ 60% |
| Library-management efficiency | Median taps to log an episode | ≤ 2 |
| Tracking accuracy | Reported progress/episode-count corrections per 100 entries | ≤ 3 |
| Collection reliability | Data-loss incidents; export success rate | 0; 100% |
| Long-term engagement | Weekly active users / registered users (owner-led cohort) | ≥ 40% |

Targets are provisional until real usage exists; revisit after v0.3.

## 9. Dependencies and constraints
- AniList API availability and terms (non-commercial use) — see [Risks](12-risks.md).
- ID mapping quality between sources.
- Free/non-commercial status is a precondition of using the sources.
- Hosting deferred: all environments run locally until the deployment phase.

## 10. Release criteria (MVP)
All v0.1–v0.4 acceptance criteria pass; NFR targets in the [SRS](04-srs.md) met; security checklist in [doc 09](09-security-privacy.md) passed; owner signs off each milestone.

## 11. Open items
See [Decisions §4](02-decisions.md). Recommendation engine design is a separate PRD addendum before post-MVP work.
