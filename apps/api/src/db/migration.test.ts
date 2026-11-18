import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { insertTitle } from '../testing/fixtures.js';
import { runPrisma } from '../testing/prismaCli.js';

/** Every M1 table of doc 06 §2 (join tables included). */
const DOC_06_TABLES = [
  'airing_episode',
  'character',
  'event',
  'franchise',
  'genre',
  'library_entry',
  'mapping_conflict',
  'mapping_dataset_entry',
  'mapping_override',
  'notification',
  'oauth_account',
  'one_time_token',
  'refresh_token',
  'share_link',
  'studio',
  'title',
  'title_character',
  'title_external_id',
  'title_genre',
  'title_relation',
  'title_studio',
  'user',
  'viewing_run',
];

const DRIFT_ARGS = [
  'migrate',
  'diff',
  '--from-config-datasource',
  '--to-schema',
  'prisma/schema.prisma',
  '--exit-code',
];

describe('migrations on an empty PostgreSQL database', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase({ state: 'empty' });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('starts from a database with no tables', async () => {
    const tables = await testDb.sql.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = current_schema()`,
    );
    expect(tables.rowCount).toBe(0);
  });

  it('`prisma migrate deploy` applies every migration cleanly', async () => {
    const result = await runPrisma(['migrate', 'deploy'], testDb.url);

    expect(result.output).toContain('All migrations have been successfully applied');
    expect(result.code).toBe(0);
  });

  it('creates exactly the tables of doc 06', async () => {
    const tables = await testDb.sql.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'
       ORDER BY tablename`,
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual(DOC_06_TABLES);
  });

  it('`prisma migrate status` reports the database as up to date', async () => {
    const result = await runPrisma(['migrate', 'status'], testDb.url);

    expect(result.output).toContain('Database schema is up to date');
    expect(result.code).toBe(0);
  });

  it('shows no drift between the migrated database and schema.prisma', async () => {
    const result = await runPrisma(DRIFT_ARGS, testDb.url);

    expect(result.output).toContain('No difference detected');
    expect(result.code).toBe(0);
  });

  it('deploying again is a no-op', async () => {
    const result = await runPrisma(['migrate', 'deploy'], testDb.url);

    expect(result.output).toContain('No pending migrations to apply');
    expect(result.code).toBe(0);
  });

  it('the drift check does detect a database that differs from schema.prisma', async () => {
    // Control for the test above: prove the command can fail. Runs last; the database is dropped.
    await testDb.sql.query('ALTER TABLE genre ADD COLUMN drifted integer');

    const result = await runPrisma(DRIFT_ARGS, testDb.url);

    expect(result.code).toBe(2);
    expect(result.output).toContain('drifted');
  });
});

describe('indexes and search (doc 06 §5)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it.each([
    [
      'library_entry_user_id_status_updated_at_idx',
      'ON public.library_entry USING btree (user_id, status, updated_at DESC)',
    ],
    [
      'library_entry_user_id_title_id_key',
      'UNIQUE INDEX library_entry_user_id_title_id_key ON public.library_entry USING btree (user_id, title_id)',
    ],
    ['event_user_id_occurred_at_seq_idx', 'ON public.event USING btree (user_id, occurred_at DESC, seq DESC)'],
    ['event_entry_id_occurred_at_seq_idx', 'ON public.event USING btree (entry_id, occurred_at, seq)'],
    [
      'notification_user_id_read_at_created_at_idx',
      'ON public.notification USING btree (user_id, read_at, created_at DESC)',
    ],
    ['title_season_year_season_idx', 'ON public.title USING btree (season_year, season)'],
    ['title_search_idx', 'ON public.title USING gin (search)'],
    ['airing_episode_airs_at_idx', 'ON public.airing_episode USING btree (airs_at)'],
    [
      'title_external_id_source_external_id_key',
      'UNIQUE INDEX title_external_id_source_external_id_key ON public.title_external_id USING btree (source, external_id)',
    ],
    [
      'viewing_run_one_open_per_entry_key',
      'UNIQUE INDEX viewing_run_one_open_per_entry_key ON public.viewing_run USING btree (entry_id) WHERE (finished_at IS NULL)',
    ],
  ])('has index %s', async (name, definition) => {
    const result = await testDb.sql.query<{ indexdef: string }>(
      'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1',
      [name],
    );
    expect(result.rows[0]?.indexdef).toContain(definition);
  });

  it('stores user.email as citext and every timestamp as timestamptz', async () => {
    const email = await testDb.sql.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'user' AND column_name = 'email'`,
    );
    expect(email.rows[0]?.udt_name).toBe('citext');

    const naive = await testDb.sql.query<{ column: string }>(
      `SELECT table_name || '.' || column_name AS column FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name <> '_prisma_migrations'
         AND data_type = 'timestamp without time zone'`,
    );
    expect(naive.rows).toEqual([]);
  });

  it('FR-DISC-001 title.search is generated from romaji, English, native names and synonyms', async () => {
    await testDb.sql.query(
      `INSERT INTO title (kind, status, title_romaji, title_english, title_native, synonyms)
       VALUES ('tv', 'finished', 'Sousou no Frieren', 'Frieren: Beyond Journey''s End',
               '葬送のフリーレン', ARRAY['Frieren at the Funeral'])`,
    );
    await insertTitle(testDb.sql, { romaji: 'Unrelated Show' });

    const search = async (query: string): Promise<string[]> => {
      const result = await testDb.sql.query<{ title_romaji: string }>(
        `SELECT title_romaji FROM title
         WHERE search @@ websearch_to_tsquery('simple', $1) ORDER BY title_romaji`,
        [query],
      );
      return result.rows.map((row) => row.title_romaji);
    };

    expect(await search('sousou')).toEqual(['Sousou no Frieren']); // romaji
    expect(await search('JOURNEY')).toEqual(['Sousou no Frieren']); // English, case-insensitive
    expect(await search('葬送のフリーレン')).toEqual(['Sousou no Frieren']); // native
    expect(await search('funeral')).toEqual(['Sousou no Frieren']); // synonym
    expect(await search('frieren unrelated')).toEqual([]); // all terms must match
    expect(await search('unrelated')).toEqual(['Unrelated Show']);
  });

  it('FR-DISC-001 title.search follows updates and cannot be written directly', async () => {
    const id = await insertTitle(testDb.sql, { romaji: 'Before Rename' });
    await testDb.sql.query(`UPDATE title SET title_romaji = 'After Rename' WHERE id = $1`, [id]);

    const hit = await testDb.sql.query(
      `SELECT 1 FROM title WHERE id = $1 AND search @@ to_tsquery('simple', 'after')
         AND NOT search @@ to_tsquery('simple', 'before')`,
      [id],
    );
    expect(hit.rowCount).toBe(1);

    await expect(
      testDb.sql.query(`UPDATE title SET search = 'x'::tsvector WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '428C9' }); // generated_always
  });

  it('FR-DISC-001 the Prisma client can create and read titles despite the generated column', async () => {
    const created = await testDb.db.client.title.create({
      data: { kind: 'movie', status: 'finished', titleEnglish: 'Client Made', synonyms: ['cm'] },
    });
    const found = await testDb.db.client.title.findUniqueOrThrow({ where: { id: created.id } });

    expect(found).toMatchObject({ titleEnglish: 'Client Made', synonyms: ['cm'], stale: false });
    expect(found).not.toHaveProperty('search');
  });
});
