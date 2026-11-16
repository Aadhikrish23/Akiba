import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Anything that can run a query: a pool or a checked-out client (inside a transaction). */
export type Queryable = Pick<pg.Pool, 'query'>;

async function insertReturningId(
  sql: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<string> {
  const result = await sql.query<{ id: string }>(text, [...values]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return row.id;
}

/** Minimal valid rows, written with plain SQL so tests exercise the database, not the client. */
export function insertUser(
  sql: Queryable,
  email = `${randomUUID()}@example.test`,
): Promise<string> {
  return insertReturningId(sql, 'INSERT INTO "user" (email) VALUES ($1) RETURNING id', [email]);
}

export function insertTitle(
  sql: Queryable,
  options: { romaji?: string | null; episodesTotal?: number | null } = {},
): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO title (kind, status, title_romaji, episodes_total)
     VALUES ('tv', 'finished', $1, $2) RETURNING id`,
    [options.romaji === undefined ? 'Test Title' : options.romaji, options.episodesTotal ?? null],
  );
}

export function insertEntry(
  sql: Queryable,
  userId: string,
  titleId: string,
  options: { progress?: number; rating?: number | null; override?: number | null } = {},
): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO library_entry (user_id, title_id, status, progress, rating, episodes_total_override)
     VALUES ($1, $2, 'watching', $3, $4, $5) RETURNING id`,
    [userId, titleId, options.progress ?? 0, options.rating ?? null, options.override ?? null],
  );
}

export function insertRun(
  sql: Queryable,
  entryId: string,
  runNumber: number,
  options: { finished?: boolean; rating?: number | null; progressAtEnd?: number | null } = {},
): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO viewing_run (entry_id, run_number, finished_at, rating, progress_at_end)
     VALUES ($1, $2, CASE WHEN $3 THEN now() END, $4, $5) RETURNING id`,
    [
      entryId,
      runNumber,
      options.finished ?? false,
      options.rating ?? null,
      options.progressAtEnd ?? null,
    ],
  );
}

export function insertEvent(
  sql: Queryable,
  ids: { userId: string; entryId: string; titleId: string; runId?: string },
  payload: Record<string, unknown> = { from: 0, to: 1, run: 1 },
): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO event (user_id, entry_id, title_id, run_id, type, payload)
     VALUES ($1, $2, $3, $4, 'progress_changed', $5) RETURNING id`,
    [ids.userId, ids.entryId, ids.titleId, ids.runId ?? null, JSON.stringify(payload)],
  );
}

export function insertEpisode(sql: Queryable, titleId: string, episode: number): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO airing_episode (title_id, episode_number, airs_at, source)
     VALUES ($1, $2, now(), 'anilist') RETURNING id`,
    [titleId, episode],
  );
}

export function insertNotification(
  sql: Queryable,
  userId: string,
  titleId: string,
  episodeId: string,
): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO notification (user_id, kind, title_id, episode_id)
     VALUES ($1, 'episode_aired', $2, $3) RETURNING id`,
    [userId, titleId, episodeId],
  );
}

export function insertShareLink(sql: Queryable, userId: string): Promise<string> {
  return insertReturningId(
    sql,
    `INSERT INTO share_link (user_id, token_hash, scope) VALUES ($1, $2, $3) RETURNING id`,
    [
      userId,
      randomUUID(),
      JSON.stringify({ statuses: ['completed'], show_ratings: false, show_reviews: false }),
    ],
  );
}
