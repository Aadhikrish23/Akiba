# Database schema and migrations

`schema.prisma` implements [docs/06-data-model.md](../docs/06-data-model.md). The Prisma CLI is
configured in [`../prisma.config.mjs`](../prisma.config.mjs) and reads `DATABASE_URL` from the
environment. The client is generated into `apps/api/src/generated/prisma` (git-ignored) and is used
only through `apps/api/src/db/index.ts`.

| Command           | What it does                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm generate`   | Generate the Prisma client (also run by `lint`, `typecheck`, `test`, `build`).                                                           |
| `pnpm db:migrate` | `prisma migrate deploy`: apply committed migrations. Run before starting a new API version.                                              |
| `pnpm db:check`   | `prisma migrate status`, then fail if the database differs from `schema.prisma`.                                                         |
| `pnpm db:seed`    | Build the API and run the seed (`apps/api/src/db/seed.ts`): genres, plus a development catalog unless `NODE_ENV=production`. Idempotent. |

Never use `prisma db push` on a database you care about: it bypasses the migrations and therefore
everything in the next section.

## What lives only in migration SQL

Prisma's schema language cannot express these, and **`pnpm db:check` cannot see them** (Prisma's
diff ignores CHECK constraints, partial indexes, functions and triggers). They are protected by the
tests in `apps/api/src/db/*.test.ts`, which run against a database built from the migrations.

| Object                                                                                                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE EXTENSION citext`                                                                                                      | `user.email` is unique regardless of letter case. Needs a role allowed to create extensions (`citext` is a trusted extension: the database owner suffices on PostgreSQL ≥ 13).                                                                                                                                                                                               |
| `library_entry_progress_check`, `…_episodes_total_override_check`, `…_rating_check`                                            | `progress >= 0`, override `>= 1`, rating 1–10 (doc 06 §2).                                                                                                                                                                                                                                                                                                                   |
| `library_entry_progress_within_override_check`                                                                                 | `progress <= episodes_total_override` when an override is stored (FR-TRK-007, the part the row knows). The bound against `title.episodes_total` is the service's job.                                                                                                                                                                                                        |
| `viewing_run_*_check`                                                                                                          | `run_number >= 1`, rating 1–10, `progress_at_end >= 0`, `finished_at >= started_at`.                                                                                                                                                                                                                                                                                         |
| `viewing_run_one_open_per_entry_key`                                                                                           | Partial unique index: at most one run with `finished_at IS NULL` per entry (doc 06 §4.3).                                                                                                                                                                                                                                                                                    |
| `title_has_a_name_check`, `title_episodes_total_check`, `title_relation_not_self_check`, `airing_episode_episode_number_check` | Catalog sanity.                                                                                                                                                                                                                                                                                                                                                              |
| `title_search_vector()` + generated column `title.search` + GIN index                                                          | Local full-text search over romaji, English, native names and synonyms (`'simple'` configuration). The column is declared in `schema.prisma` as `Unsupported("tsvector")` with a `dbgenerated` default, which is how Prisma's introspection sees a generated column; keep the two in step. Query it with raw SQL, e.g. `WHERE search @@ websearch_to_tsquery('simple', $1)`. |
| `event_append_only_guard()` + triggers `event_append_only_row`, `event_append_only_truncate`                                   | `event` is append-only, see below.                                                                                                                                                                                                                                                                                                                                           |

## `event` is append-only

`UPDATE`, `DELETE` and `TRUNCATE` on `event` fail with SQLSTATE `AKB01`
(`event is append-only: <operation> is not allowed`). That includes changes that arrive through a
foreign key: hard-deleting a user, a library entry or a viewing run that has events fails. Entries
are therefore soft-removed (`library_entry.removed_at`), never deleted.

Two maintenance jobs may opt in, per transaction:

```sql
BEGIN;
SELECT set_config('akiba.event_maintenance', 'purge', true);  -- true = this transaction only
DELETE FROM "user" WHERE id = $1;   -- cascades to entries, runs, events, tokens, notifications, share link
COMMIT;
```

- `purge` (account purge after the grace period, doc 06 §6): allows `DELETE` and `TRUNCATE`.
  `UPDATE` stays forbidden.
- `merge` (merging duplicate titles, doc 05 §5): allows `UPDATE` of `title_id`, `entry_id` and
  `run_id` only. Any other column change, `DELETE` and `TRUNCATE` stay forbidden.

With the Prisma client, do this inside an interactive `$transaction` (`tx.$queryRaw` for
`set_config`, then the deletes on the same `tx`). Always pass `true` as the third argument so the
setting cannot leak to the next user of a pooled connection.

This is a guard against application bugs and stray SQL, not a security boundary: any role that can
run SQL can set the parameter, and the table owner can disable triggers.

## Foreign-key rules

- Deleting a **user** cascades to everything they own (OAuth links, tokens, entries → runs, events,
  notifications, share link). Because of the guard above it only succeeds in `purge` mode once the
  user has events.
- A **title** referenced by a library entry, an event or a manual mapping override cannot be
  deleted (`RESTRICT`). Its own catalog rows (external IDs, relations, genres, studios, characters,
  airing episodes and their notifications) are deleted with it.
- Deleting a **franchise** sets `title.franchise_id` to NULL; deleting a replacement refresh token
  sets `replaced_by_id` to NULL.

## Writing the next migration

1. Edit `schema.prisma`.
2. With `DATABASE_URL` pointing at a database that has all current migrations applied, generate the
   SQL (the command prints nothing useful without `DATABASE_URL`):
   `pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o prisma/migrations/<UTC timestamp>_<name>/migration.sql`
   (`prisma migrate dev --create-only` also works, but needs a shadow database.)
3. Add by hand whatever Prisma cannot express, and a test for it.
4. `pnpm db:migrate && pnpm db:check && pnpm test`.

Applied migrations are never edited. A destructive migration needs an explicit note in its commit
message (doc 06 §7).
