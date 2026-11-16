# Carry-forward notes (read before starting your task)

Open items and decisions passed from finished tasks to later ones. Developers: read this first; add items you create for later tasks; the coordinator prunes.

## From T2 (api-skeleton)
- Rate limits are **per IP** in T2. **T4** adds per-user limits for authenticated routes (doc 07: writes 120/min/user, reads 600/min/user) and the stricter auth limiter (10/min/IP) via the limiter factory.
- Problem-details `type` is a relative URI (`/errors/validation`); keep unless the owner supplies a canonical origin.
- No production route had a validated body in T2, so 422 was only proven by supertest; **T4** adds real validated routes and should add a smoke check for 422.
- Smoke harness: add a new `scripts/smoke.d/NN-name.sh` per feature; keep request counts within the smoke rate-limit budget; `99-` is reserved for replay/logout.

## From T3 (prisma-schema)
- `library_entry.removed_at` exists (soft-remove). Unique `(user_id, title_id)` still covers removed rows → **T15 must revive the tombstone on re-add**, not insert a new row.
- DB rejects `progress > episodes_total_override` → **T16 must decide** (and document) whether lowering an override clamps progress or is refused.
- `event` is append-only via trigger, which also blocks cascades → **T17 account purge** must run `set_config('akiba.event_maintenance','purge',true)` inside its transaction; a `merge` mode exists for **T9** title merges. See `prisma/README.md`.
- Requirement IDs: FR-REM-007 = events append-only; FR-REM-004 = rewatch/one open run.
- `pnpm test` needs `DATABASE_URL` with CREATEDB rights; test harness uses one DB per test file (citext). Local Postgres: `/usr/lib/postgresql/16` (initdb in a temp dir, port 55432).
- Prisma pinned to 7.10.1 (registry `latest` is an 8.x RC). Seed lives in `apps/api/src/db/`.
- Seed catalog facts were written from memory, not verified against AniList/MAL — do not treat as ground truth.
- **T19:** no column for the adult-content toggle yet — add a migration when needed (user setting).
- `date` columns cannot hold partial source dates (AniList can return year/month only) — handle in adapters (**T8**) by normalising.
- `/ready` now does a real `SELECT 1`; smoke checks it.

## Standing rules
- No PRs, no merges, no reviewer/tester agents; commit and push directly to `ccr-0014c7e1-32mc28`, then check CI + Smoke and fix forward.
- Never pipe a gate (lint/typecheck/test) through `tail`/`head` in a way that hides its exit code (T3 lesson) — check exit codes.
- Validate workflow YAML before pushing (T3 lesson).
