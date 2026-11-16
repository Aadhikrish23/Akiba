import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/database.js';
import { seedDatabase } from './seed.js';
import { SEED_GENRES, SEED_RELATIONS, SEED_TITLES } from './seedData.js';

const CATALOG_TABLES = [
  'genre',
  'title',
  'title_external_id',
  'title_relation',
  'title_genre',
  'studio',
  'title_studio',
] as const;

let testDb: TestDatabase;

/** Every seeded row, IDs included, in a stable order. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of CATALOG_TABLES) {
    const rows = await testDb.sql.query(
      `SELECT to_jsonb(t) - 'search' AS row FROM "${table}" t ORDER BY 1`,
    );
    result[table] = rows.rows.map((entry: { row: unknown }) => entry.row);
  }
  return result;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

beforeEach(async () => {
  await testDb.reset();
});

describe('seed (doc 06 §7)', () => {
  it('loads the genres and the development catalog into an empty database', async () => {
    const summary = await seedDatabase(testDb.db.client, { includeDevCatalog: true });

    expect(summary).toEqual({
      genres: SEED_GENRES.length,
      titles: SEED_TITLES.length,
      relations: SEED_RELATIONS.length,
    });
    const data = await snapshot();
    expect(data['genre']).toHaveLength(SEED_GENRES.length);
    expect(data['title']).toHaveLength(SEED_TITLES.length);
    expect(data['title_relation']).toHaveLength(SEED_RELATIONS.length);
    expect(data['title_external_id']).toHaveLength(
      SEED_TITLES.reduce((total, title) => total + title.externalIds.length, 0),
    );
    expect(data['title_genre']).toHaveLength(
      SEED_TITLES.reduce((total, title) => total + title.genres.length, 0),
    );
    expect(data['studio']).toHaveLength(new Set(SEED_TITLES.map((title) => title.studio)).size);
    expect(data['title_studio']).toHaveLength(SEED_TITLES.length);
  });

  it('is idempotent: a second and third run change nothing', async () => {
    await seedDatabase(testDb.db.client, { includeDevCatalog: true });
    const first = await snapshot();

    await seedDatabase(testDb.db.client, { includeDevCatalog: true });
    await seedDatabase(testDb.db.client, { includeDevCatalog: true });

    expect(await snapshot()).toEqual(first);
  });

  it('resolves both external IDs of a seeded title to the same Akiba ID, with its relations', async () => {
    await seedDatabase(testDb.db.client, { includeDevCatalog: true });
    const { client } = testDb.db;

    const viaAniList = await client.titleExternalId.findUniqueOrThrow({
      where: { source_externalId: { source: 'anilist', externalId: '1' } },
    });
    const viaMal = await client.titleExternalId.findUniqueOrThrow({
      where: { source_externalId: { source: 'mal', externalId: '1' } },
    });
    expect(viaMal.titleId).toBe(viaAniList.titleId);

    const title = await client.title.findUniqueOrThrow({
      where: { id: viaAniList.titleId },
      include: {
        relationsFrom: { include: { toTitle: true } },
        genres: { include: { genre: true } },
        studios: { include: { studio: true } },
      },
    });
    expect(title.titleRomaji).toBe('Cowboy Bebop');
    expect(title.episodesTotal).toBe(26);
    expect(title.startDate?.toISOString()).toBe('1998-04-03T00:00:00.000Z');
    expect(title.stale).toBe(true);
    expect(title.relationsFrom.map((r) => [r.relationType, r.toTitle.titleRomaji])).toEqual([
      ['side_story', 'Cowboy Bebop: Tengoku no Tobira'],
    ]);
    expect(title.genres.map((g) => g.genre.name).sort()).toEqual([
      'Action',
      'Adventure',
      'Drama',
      'Sci-Fi',
    ]);
    expect(title.studios.map((s) => [s.studio.name, s.isMain])).toEqual([['Sunrise', true]]);
  });

  it('keeps existing data: user-added genres survive and an edited seed title is restored', async () => {
    await seedDatabase(testDb.db.client, { includeDevCatalog: true });
    await testDb.sql.query(`INSERT INTO genre (name) VALUES ('Custom Genre')`);
    await testDb.sql.query(
      `UPDATE title SET episodes_total = 99 WHERE title_romaji = 'Cowboy Bebop'`,
    );

    await seedDatabase(testDb.db.client, { includeDevCatalog: true });

    const genres = await testDb.sql.query('SELECT 1 FROM genre');
    expect(genres.rowCount).toBe(SEED_GENRES.length + 1);
    const bebop = await testDb.sql.query<{ episodes_total: number }>(
      `SELECT episodes_total FROM title WHERE title_romaji = 'Cowboy Bebop'`,
    );
    expect(bebop.rows).toEqual([{ episodes_total: 26 }]);
  });

  it('loads only genres when the development catalog is not requested (production)', async () => {
    const summary = await seedDatabase(testDb.db.client, { includeDevCatalog: false });
    await seedDatabase(testDb.db.client, { includeDevCatalog: false });

    expect(summary).toEqual({ genres: SEED_GENRES.length, titles: 0, relations: 0 });
    const data = await snapshot();
    expect(data['genre']).toHaveLength(SEED_GENRES.length);
    expect(data['title']).toEqual([]);
    expect(data['studio']).toEqual([]);
  });

  it('seed data is internally consistent', () => {
    const keys = SEED_TITLES.map((title) => title.key);
    expect(new Set(keys).size).toBe(keys.length);
    const externalIds = SEED_TITLES.flatMap((title) =>
      title.externalIds.map((id) => `${id.source}:${id.externalId}`),
    );
    expect(new Set(externalIds).size).toBe(externalIds.length);
    for (const relation of SEED_RELATIONS) {
      expect(keys).toContain(relation.from);
      expect(keys).toContain(relation.to);
      expect(relation.from).not.toBe(relation.to);
    }
    expect(new Set(SEED_GENRES).size).toBe(SEED_GENRES.length);
  });
});
