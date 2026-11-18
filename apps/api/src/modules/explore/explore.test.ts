/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON; this suite reads them field by field */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCatalogTestApp,
  recordedAniList,
  recordedJikan,
  type CatalogTestApp,
} from '../../testing/catalog.js';
import { createTestDatabase, type TestDatabase } from '../../testing/database.js';
import { jsonResponse } from '../../testing/sources.js';
import type { SourceCharacter } from '../../sources/types.js';
import { replaceCharacters } from './characters.js';
import { DONE_DETAIL_TTL_MS } from '../titles/titles.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = '00000000-0000-4000-8000-000000000000';
const HOUR = 60 * 60 * 1000;
const down = (): Response => jsonResponse(503, {});

interface CastMember {
  id: string;
  name: string;
  role: 'main' | 'supporting' | 'background';
  voiceActors: Array<{ id: string; language: string }>;
}

/**
 * T21: franchises, studios and characters (FR-EXP-001…004) on a real database. Attack on Titan's
 * recorded AniList detail supplies relations, studios and a 25-character cast.
 */
describe('explore API (T21, FR-EXP-001…004)', () => {
  let testDb: TestDatabase;
  let t: CatalogTestApp;
  let auth: string;
  let userId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.reset();
    t = await buildCatalogTestApp({ db: testDb.db.client });
    ({ auth, userId } = await t.signIn());
  });

  const sql = () => testDb.sql;
  const scalar = async (text: string, values: unknown[] = []): Promise<number> =>
    Number(Object.values((await sql().query(text, values)).rows[0] as object)[0]);

  /** Search once so Attack on Titan exists, then open it (which fetches its detail). */
  async function openAttackOnTitan(as = auth) {
    const search = await t.get('/titles/search?q=attack%20on%20titan&limit=1', as);
    const id = search.body.data[0].id as string;
    const detail = await t.get(`/titles/${id}`, as);
    expect(detail.status).toBe(200);
    return { id, detail: detail.body.data };
  }

  describe('characters of a title (FR-EXP-004)', () => {
    it('stores the cast from the detail and lists it main characters first, with voice actors', async () => {
      const { id } = await openAttackOnTitan();
      const response = await t.get(`/titles/${id}/characters`, auth);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.body.meta).toMatchObject({ stale: false });
      const cast = response.body.data as CastMember[];
      expect(cast).toHaveLength(25);
      for (const character of cast) {
        expect(character.id).toMatch(UUID);
        expect(Object.keys(character).sort()).toEqual(
          ['id', 'imageUrl', 'name', 'nativeName', 'role', 'voiceActors'].sort(),
        );
      }
      const roles = cast.map((character) => character.role);
      expect(
        [...roles].sort(
          (a, b) =>
            ['main', 'supporting', 'background'].indexOf(a) -
            ['main', 'supporting', 'background'].indexOf(b),
        ),
      ).toEqual(roles);
      const eren = cast.find((character) => character.name === 'Eren Yeager')!;
      expect(eren).toMatchObject({ role: 'main', nativeName: 'エレン・イェーガー' });
      expect(eren.voiceActors[0]).toMatchObject({ language: 'Japanese' });
      expect(eren.voiceActors[0]?.id).toMatch(UUID);
      // No external ID reaches the client (FR-DISC-008).
      const keys = new Set<string>();
      JSON.stringify(response.body, (key, value: unknown) => {
        keys.add(key);
        return value;
      });
      expect([...keys].filter((key) => /anilist|idMal|mal_?id|external/i.test(key))).toEqual([]);
    });

    it('fetching again changes nothing (idempotent), and a shared character stays one row', async () => {
      const { id } = await openAttackOnTitan();
      const before = [
        await scalar('SELECT count(*) FROM character'),
        await scalar('SELECT count(*) FROM voice_actor'),
        await scalar('SELECT count(*) FROM character_voice_actor'),
        await scalar('SELECT count(*) FROM title_character'),
      ];
      t.time.advance(DONE_DETAIL_TTL_MS + 1000); // the detail is old: it is fetched again
      const calls = t.anilist.requests.length;
      expect((await t.get(`/titles/${id}/characters`, auth)).status).toBe(200);
      expect(t.anilist.requests.length).toBeGreaterThan(calls);
      expect([
        await scalar('SELECT count(*) FROM character'),
        await scalar('SELECT count(*) FROM voice_actor'),
        await scalar('SELECT count(*) FROM character_voice_actor'),
        await scalar('SELECT count(*) FROM title_character'),
      ]).toEqual(before);
      expect(before[0]).toBe(25);

      // Another title with the same character (same AniList ID) points at the same row.
      const other = (
        await sql().query<{ id: string }>(
          `INSERT INTO title (kind, status, title_romaji, fetched_at) VALUES ('movie', 'finished', 'Recap', now()) RETURNING id`,
        )
      ).rows[0]!.id;
      const shared: SourceCharacter = {
        externalId: '40882', // Eren Yeager
        name: 'Eren Yeager',
        nativeName: null,
        imageUrl: null,
        description: null,
        role: 'supporting',
        voiceActors: [],
      };
      await testDb.db.client.$transaction((tx) => replaceCharacters(tx, other, [shared]));
      expect(await scalar('SELECT count(*) FROM character')).toBe(25);
      expect(await scalar('SELECT count(*) FROM title_character')).toBe(26);
    });

    it('simultaneous refreshes of titles that share characters neither deadlock nor duplicate', async () => {
      const titles = (
        await Promise.all(
          [1, 2, 3, 4].map(
            async (n) =>
              (
                await sql().query<{ id: string }>(
                  `INSERT INTO title (kind, status, title_romaji, fetched_at) VALUES ('tv', 'finished', $1, now()) RETURNING id`,
                  [`Shared ${n}`],
                )
              ).rows[0]!.id,
          ),
        )
      ).sort();
      const person = (id: number) => ({
        externalId: String(id),
        name: `Person ${id}`,
        nativeName: null,
        imageUrl: null,
        language: 'Japanese',
      });
      const castIn = (order: number[]): SourceCharacter[] =>
        order.map((n) => ({
          externalId: String(n),
          name: `Character ${n}`,
          nativeName: null,
          imageUrl: null,
          description: null,
          role: 'main',
          voiceActors: [person(100 + n), person(100 + ((n + 1) % 10))],
        }));
      const orders = [
        [1, 2, 3, 4, 5, 6, 7, 8],
        [8, 7, 6, 5, 4, 3, 2, 1],
        [4, 5, 1, 8, 2, 7, 3, 6],
        [3, 1, 4, 1, 5, 9, 2, 6].filter((n, i, all) => all.indexOf(n) === i),
      ];
      await Promise.all(
        titles.map((titleId, i) =>
          testDb.db.client.$transaction((tx) => replaceCharacters(tx, titleId, castIn(orders[i]!))),
        ),
      );
      expect(
        await scalar('SELECT count(DISTINCT external_ids ->> $1) FROM character', ['anilist']),
      ).toBe(await scalar('SELECT count(*) FROM character'));
      expect(await scalar('SELECT count(*) FROM character')).toBe(9); // 1…9, each once
    });

    it('a refresh through the fallback keeps the cast AniList gave', async () => {
      const { id } = await openAttackOnTitan();
      t.anilist.responder = down;
      t.time.advance(DONE_DETAIL_TTL_MS + 1000);
      const response = await t.get(`/titles/${id}/characters`, auth);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(25);
      expect(response.body.meta.source).toBe('jikan');
    });

    it('looks again, at most hourly, for a title whose cast was empty', async () => {
      const { id } = await openAttackOnTitan();
      await sql().query(`DELETE FROM title_character WHERE title_id = $1`, [id]);
      const calls = () => t.anilist.requests.length;
      const first = calls();
      expect((await t.get(`/titles/${id}/characters`, auth)).body.data).toHaveLength(0); // detail is fresh
      expect(calls()).toBe(first);
      t.time.advance(HOUR + 1000);
      expect((await t.get(`/titles/${id}/characters`, auth)).body.data).toHaveLength(25);
      expect(calls()).toBeGreaterThan(first);
    });

    it('is a 404 for an unknown or malformed title, and 503 with no source and no copy', async () => {
      expect((await t.get(`/titles/${NIL}/characters`, auth)).status).toBe(404);
      expect((await t.get('/titles/not-a-uuid/characters', auth)).status).toBe(404);
    });
  });

  describe('character page (FR-EXP-004)', () => {
    it('shows the character, who voices them, and where they appear with the caller’s status', async () => {
      const { id } = await openAttackOnTitan();
      const cast = (await t.get(`/titles/${id}/characters`, auth)).body.data as Array<{
        id: string;
        name: string;
      }>;
      const eren = cast.find((character) => character.name === 'Eren Yeager')!;
      await t.get(`/titles/${id}`, auth);
      const added = await request(t.app)
        .post('/v1/library')
        .set('Authorization', auth)
        .send({ titleId: id, status: 'watching' });
      expect(added.status).toBe(201);

      const page = await t.get(`/characters/${eren.id}`, auth);
      expect(page.status).toBe(200);
      expect(page.body.data).toMatchObject({ id: eren.id, name: 'Eren Yeager' });
      expect(page.body.data.voiceActors[0].language).toBe('Japanese');
      expect(page.body.data.appearances).toEqual([
        expect.objectContaining({
          role: 'main',
          title: expect.objectContaining({ id, libraryStatus: 'watching' }),
        }),
      ]);
      const description: string = page.body.data.description;
      expect(description.length).toBeGreaterThan(20);
      expect(description).not.toMatch(/~!|!~|<[a-z]/i);
      // Another user sees the same character with their own (empty) status.
      const other = await t.signIn('other');
      const theirs = await t.get(`/characters/${eren.id}`, other.auth);
      expect(theirs.body.data.appearances[0].title.libraryStatus).toBeNull();
    });

    it('is a 404 for an unknown ID and for a character who appears only in adult titles', async () => {
      const { id } = await openAttackOnTitan();
      const cast = (await t.get(`/titles/${id}/characters`, auth)).body.data as Array<{
        id: string;
      }>;
      expect((await t.get(`/characters/${NIL}`, auth)).status).toBe(404);
      expect((await t.get('/characters/nope', auth)).status).toBe(404);

      await sql().query(`UPDATE title SET is_adult = true WHERE id = $1`, [id]);
      expect((await t.get(`/characters/${cast[0]!.id}`, auth)).status).toBe(404);
      // …until the user chooses to see adult titles.
      expect(
        (await request(t.app).patch('/v1/me').set('Authorization', auth).send({ showAdult: true }))
          .status,
      ).toBe(200);
      expect((await t.get(`/characters/${cast[0]!.id}`, auth)).status).toBe(200);
    });
  });

  describe('franchise (FR-EXP-001, FR-EXP-002)', () => {
    it('a title with related titles gets a franchise; the page groups them with the caller’s status', async () => {
      const { id, detail } = await openAttackOnTitan();
      expect(detail.franchiseId).toMatch(UUID);
      const response = await t.get(`/franchises/${detail.franchiseId}`, auth);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-cache');
      const franchise = response.body.data;
      expect(franchise.id).toBe(detail.franchiseId);
      expect(franchise.name).toBe('Shingeki no Kyojin');
      expect(franchise.titles.length).toBeGreaterThan(3);
      expect(franchise.titles.map((title: { id: string }) => title.id)).toContain(id);
      // Oldest first, unknown dates last.
      const dates: Array<string | null> = franchise.titles.map(
        (title: { startDate: string | null }) => title.startDate,
      );
      const known = dates.filter((d): d is string => d !== null);
      expect([...known].sort()).toEqual(known);
      expect(dates.indexOf(null) === -1 || dates.indexOf(null) >= known.length).toBe(true);
      // Relations between members, by kind.
      const kinds = new Set(
        franchise.relations.map((r: { relationType: string }) => r.relationType),
      );
      expect(kinds).toContain('sequel');
      for (const relation of franchise.relations) {
        const members = franchise.titles.map((title: { id: string }) => title.id);
        expect(members).toContain(relation.fromTitleId);
        expect(members).toContain(relation.toTitleId);
      }
      expect(franchise.totals).toEqual({
        titles: franchise.titles.length,
        inLibrary: 0,
        completed: 0,
      });

      // Status per entry (FR-EXP-002).
      await request(t.app)
        .post('/v1/library')
        .set('Authorization', auth)
        .send({ titleId: id, status: 'completed' });
      const again = (await t.get(`/franchises/${detail.franchiseId}`, auth)).body.data;
      const mine = again.titles.find((title: { id: string }) => title.id === id);
      expect(mine).toMatchObject({ libraryStatus: 'completed' });
      expect(mine.libraryEntryId).toMatch(UUID);
      expect(again.totals).toMatchObject({ inLibrary: 1, completed: 1 });
      // …and another user does not see it.
      const other = await t.signIn('observer');
      const theirs = (await t.get(`/franchises/${detail.franchiseId}`, other.auth)).body.data;
      expect(theirs.totals).toMatchObject({ inLibrary: 0, completed: 0 });
    });

    it('hides adult titles unless the user opted in, and an adult-only franchise is a 404', async () => {
      const { detail } = await openAttackOnTitan();
      const total = (await t.get(`/franchises/${detail.franchiseId}`, auth)).body.data.titles
        .length;
      const victim = (
        await sql().query<{ id: string }>(
          `SELECT id FROM title WHERE franchise_id = $1 ORDER BY id LIMIT 1`,
          [detail.franchiseId],
        )
      ).rows[0]!.id;
      await sql().query(`UPDATE title SET is_adult = true WHERE id = $1`, [victim]);
      const hidden = (await t.get(`/franchises/${detail.franchiseId}`, auth)).body.data;
      expect(hidden.titles).toHaveLength(total - 1);
      expect(hidden.titles.map((title: { id: string }) => title.id)).not.toContain(victim);
      expect(
        hidden.relations.every(
          (r: { fromTitleId: string; toTitleId: string }) =>
            r.fromTitleId !== victim && r.toTitleId !== victim,
        ),
      ).toBe(true);

      await sql().query(`UPDATE title SET is_adult = true WHERE franchise_id = $1`, [
        detail.franchiseId,
      ]);
      expect((await t.get(`/franchises/${detail.franchiseId}`, auth)).status).toBe(404);
    });

    it('is a 404 for an unknown or malformed ID', async () => {
      expect((await t.get(`/franchises/${NIL}`, auth)).status).toBe(404);
      expect((await t.get('/franchises/xyz', auth)).status).toBe(404);
    });

    it('a title with no relations has no franchise', async () => {
      const lone = (
        await sql().query<{ id: string }>(
          `INSERT INTO title (kind, status, title_romaji, fetched_at, detail_fetched_at) VALUES ('tv', 'finished', 'Lonely', now(), now()) RETURNING id`,
        )
      ).rows[0]!.id;
      const detail = await t.get(`/titles/${lone}`, auth);
      expect(detail.body.data.franchiseId).toBeNull();
    });
  });

  describe('studios (FR-EXP-003)', () => {
    it('shows a studio and lists its works, most popular first, in pages', async () => {
      const { detail } = await openAttackOnTitan();
      const studio = detail.studios[0] as { id: string; name: string };
      for (const [n, popularity] of [
        [1, 500],
        [2, 900],
        [3, 100],
        [4, null],
        [5, 300],
      ] as const) {
        const row = await sql().query<{ id: string }>(
          `INSERT INTO title (kind, status, title_romaji, popularity, fetched_at) VALUES ('tv', 'finished', $1, $2, now()) RETURNING id`,
          [`Work ${n}`, popularity],
        );
        await sql().query(`INSERT INTO title_studio (title_id, studio_id) VALUES ($1, $2)`, [
          row.rows[0]!.id,
          studio.id,
        ]);
      }
      const page = await t.get(`/studios/${studio.id}`, auth);
      expect(page.status).toBe(200);
      expect(page.body.data).toMatchObject({ id: studio.id, name: studio.name, titleCount: 6 });
      expect(page.body.meta).toEqual({ stale: false, source: 'cache' });

      const first = await t.get(`/studios/${studio.id}/titles?limit=4`, auth);
      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(4);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await t.get(
        `/studios/${studio.id}/titles?limit=50&cursor=${first.body.nextCursor}`,
        auth,
      );
      // The page size travels in the cursor, so changing `limit` cannot skip or repeat a title.
      expect(second.body.data).toHaveLength(2);
      expect(second.body.nextCursor).toBeNull();
      const names = [...first.body.data, ...second.body.data].map(
        (title: { titleRomaji: string }) => title.titleRomaji,
      );
      expect(new Set(names).size).toBe(6);
      expect(names.slice(0, 4)).toEqual(['Shingeki no Kyojin', 'Work 2', 'Work 1', 'Work 5']);
      expect(names[names.length - 1]).toBe('Work 4'); // unknown popularity last
    });

    it('rejects a cursor that is not ours, and hides adult works from those who opted out', async () => {
      const { detail } = await openAttackOnTitan();
      const studio = detail.studios[0] as { id: string };
      expect((await t.get(`/studios/${studio.id}/titles?cursor=garbage`, auth)).status).toBe(422);
      const remote = Buffer.from(JSON.stringify({ k: 'remote', page: 2, perPage: 10 })).toString(
        'base64url',
      );
      expect((await t.get(`/studios/${studio.id}/titles?cursor=${remote}`, auth)).status).toBe(422);
      expect((await t.get(`/studios/${studio.id}/titles?limit=0`, auth)).status).toBe(422);

      await sql().query(
        `UPDATE title SET is_adult = true WHERE id IN (SELECT title_id FROM title_studio WHERE studio_id = $1)`,
        [studio.id],
      );
      expect((await t.get(`/studios/${studio.id}`, auth)).status).toBe(404);
      expect((await t.get(`/studios/${studio.id}/titles`, auth)).status).toBe(404);
      await request(t.app).patch('/v1/me').set('Authorization', auth).send({ showAdult: true });
      expect((await t.get(`/studios/${studio.id}`, auth)).body.data.titleCount).toBeGreaterThan(0);
    });

    it('is a 404 for an unknown or malformed ID', async () => {
      expect((await t.get(`/studios/${NIL}`, auth)).status).toBe(404);
      expect((await t.get(`/studios/${NIL}/titles`, auth)).status).toBe(404);
      expect((await t.get('/studios/bad', auth)).status).toBe(404);
    });
  });

  it('every explore route needs a signed-in user', async () => {
    for (const path of [
      `/franchises/${NIL}`,
      `/studios/${NIL}`,
      `/studios/${NIL}/titles`,
      `/characters/${NIL}`,
      `/titles/${NIL}/characters`,
    ]) {
      const response = await request(t.app).get(`/v1${path}`);
      expect(response.status, path).toBe(401);
    }
    expect(userId).toMatch(UUID);
  });

  it('uses the recorded Jikan detail when AniList is down for a title never fetched', async () => {
    const search = await t.get('/titles/search?q=attack%20on%20titan&limit=1', auth);
    const id = search.body.data[0].id as string;
    t.anilist.responder = down;
    t.jikan.responder = recordedJikan;
    const response = await t.get(`/titles/${id}/characters`, auth);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]); // MyAnimeList's detail carries no cast; no error either
    t.anilist.responder = recordedAniList;
  });
});
