# Akiba (秋葉) — Project Documentation

**Ecosystem:** Yume · **Category:** Anime discovery & personal library management
**Doc set version:** 1.0 · **Date:** 2026-11-15 · **Status:** Baseline for implementation

## Reading order

| # | Document | Read it to learn |
|---|---|---|
| 01 | [Vision](01-vision.md) | Why Akiba exists (approved baseline v1.0) |
| 02 | [Decisions](02-decisions.md) | What was decided, what is parked, what is still open |
| 03 | [PRD](03-prd.md) | What we are building and for whom |
| 04 | [SRS](04-srs.md) | Testable requirements (functional + non-functional) |
| 05 | [Architecture](05-architecture.md) | How the system is structured |
| 06 | [Data model](06-data-model.md) | Entities, relationships, event log |
| 07 | [API spec](07-api-spec.md) | REST contract between clients and backend |
| 08 | [UX design](08-ux-design.md) | "Shelf" design direction, tokens, screens |
| 09 | [Security & privacy](09-security-privacy.md) | Auth, threat model, privacy, data rights |
| 10 | [Roadmap](10-roadmap.md) | Milestones M1–M7 and exit criteria |
| 11 | [Test strategy](11-test-strategy.md) | How we prove it works |
| 12 | [Risks](12-risks.md) | Risk register |

Design mockup: [`mockups/shelf.html`](mockups/shelf.html) (open in a browser).

## Precedence

If documents disagree: **Vision > Decisions > PRD > SRS > Architecture / Data model / API / UX > others.**
Anything not covered is an *Open question* (see Decisions §4) and must be resolved before the milestone that needs it.

## ID conventions

- Functional requirements: `FR-<AREA>-NNN` (areas: AUTH, DISC, LIB, TRK, REM, EXP, NOTE, ACCT, SHARE)
- Non-functional: `NFR-<AREA>-NNN` (PERF, SEC, PRIV, A11Y, REL, MNT, COMP)
- Decisions: `D-NN`; open questions: `Q-NN`; risks: `R-NN`; user stories: `US-NN`.

## Glossary

| Term | Meaning |
|---|---|
| **Title** | Any anime entry: TV series, movie, OVA, ONA, special |
| **Akiba ID** | Internal stable identifier for a Title; maps to external source IDs |
| **Source** | External metadata provider (AniList primary, MAL/Jikan fallback) |
| **Library entry** | A user's relationship to a Title (status, progress, rating, review) |
| **Run** | One viewing pass of a Title; a rewatch is a new Run |
| **Event** | Append-only record of something the user did (added, watched ep N, completed…) |
| **Franchise** | Group of Titles linked by relations (prequel, sequel, side story…) |
| **Inbox** | In-app list of notifications (e.g. new episode aired) |
| **Share link** | Optional read-only public link to a user's list |
