import type {
  CatalogMeta,
  CharacterResponse,
  FranchiseResponse,
  StudioResponse,
  StudioTitlesQuery,
  TitleListResponse,
} from '@akiba/shared';
import type { DbClient } from '../../db/index.js';
import { invalidCursor, notFound } from '../../lib/errors.js';
import { cardSelect, toCard } from '../titles/catalog.js';
import { decodeCursor, encodeCursor } from '../titles/cursor.js';
import { toVoiceActors, voiceActorSelect } from './characters.js';

/** Everything here is read from Akiba's own copy of the catalog, so it is never "stale". */
const LOCAL_META: CatalogMeta = { stale: false, source: 'cache' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A franchise is capped at this many titles when built, so a page never needs paging. */
const FRANCHISE_PAGE_MAX = 200;
const CHARACTER_APPEARANCES_MAX = 50;
const ROLE_ORDER = { main: 0, supporting: 1, background: 2 } as const;

export interface ExploreService {
  franchise(userId: string, franchiseId: string): Promise<FranchiseResponse>;
  studio(userId: string, studioId: string): Promise<StudioResponse>;
  studioTitles(
    userId: string,
    studioId: string,
    query: StudioTitlesQuery,
  ): Promise<TitleListResponse>;
  character(userId: string, characterId: string): Promise<CharacterResponse>;
}

const dateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

/**
 * Franchise, studio and character pages (FR-EXP-001…004). Adult-rated titles are left out unless
 * the caller turned them on (Q-10), and a page that would be empty without them is a 404, so an
 * adult-only franchise, studio or character is not even discoverable by ID.
 */
export function createExploreService(options: { readonly db: DbClient }): ExploreService {
  const { db } = options;

  async function adultFor(userId: string): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { showAdult: true } });
    return user?.showAdult === true;
  }
  const visible = (adult: boolean) => (adult ? {} : { isAdult: false });

  async function franchise(userId: string, franchiseId: string): Promise<FranchiseResponse> {
    if (!UUID.test(franchiseId)) throw notFound();
    const adult = await adultFor(userId);
    const found = await db.franchise.findUnique({
      where: { id: franchiseId },
      select: { id: true, name: true },
    });
    if (found === null) throw notFound();
    const rows = await db.title.findMany({
      where: { franchiseId, ...visible(adult) },
      select: { ...cardSelect(userId), startDate: true },
      take: FRANCHISE_PAGE_MAX,
    });
    if (rows.length === 0) throw notFound();
    rows.sort(
      (a, b) =>
        (a.startDate?.getTime() ?? Infinity) - (b.startDate?.getTime() ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
    const ids = rows.map((row) => row.id);
    const relations = await db.titleRelation.findMany({
      where: { fromTitleId: { in: ids }, toTitleId: { in: ids } },
      select: { fromTitleId: true, toTitleId: true, relationType: true },
      orderBy: [{ fromTitleId: 'asc' }, { toTitleId: 'asc' }, { relationType: 'asc' }],
    });
    const titles = rows.map((row) => ({ ...toCard(row), startDate: dateOnly(row.startDate) }));
    return {
      data: {
        id: found.id,
        name: found.name,
        titles,
        relations,
        totals: {
          titles: titles.length,
          inLibrary: titles.filter((title) => title.libraryStatus !== null).length,
          completed: titles.filter((title) => title.libraryStatus === 'completed').length,
        },
      },
      meta: LOCAL_META,
    };
  }

  async function studio(userId: string, studioId: string): Promise<StudioResponse> {
    if (!UUID.test(studioId)) throw notFound();
    const adult = await adultFor(userId);
    const found = await db.studio.findUnique({
      where: { id: studioId },
      select: { id: true, name: true, isAnimationStudio: true },
    });
    if (found === null) throw notFound();
    const titleCount = await db.titleStudio.count({
      where: { studioId, title: visible(adult) },
    });
    // A studio whose every known work is adult-rated is hidden from those who opted out.
    if (titleCount === 0 && !adult) {
      const any = await db.titleStudio.count({ where: { studioId } });
      if (any > 0) throw notFound();
    }
    return { data: { ...found, titleCount }, meta: LOCAL_META };
  }

  async function studioTitles(
    userId: string,
    studioId: string,
    query: StudioTitlesQuery,
  ): Promise<TitleListResponse> {
    await studio(userId, studioId); // the same 404s as the page itself
    const adult = await adultFor(userId);
    const cursor = decodeCursor(query.cursor);
    if (cursor !== undefined && cursor.k !== 'local') throw invalidCursor();
    const perPage = cursor?.perPage ?? query.limit;
    const offset = cursor?.offset ?? 0;
    const rows = await db.titleStudio.findMany({
      where: { studioId, title: visible(adult) },
      select: { titleId: true, title: { select: cardSelect(userId) } },
      orderBy: [{ title: { popularity: { sort: 'desc', nulls: 'last' } } }, { titleId: 'asc' }],
      skip: offset,
      take: perPage + 1,
    });
    const more = rows.length > perPage;
    return {
      data: rows.slice(0, perPage).map((row) => toCard(row.title)),
      nextCursor: more ? encodeCursor({ k: 'local', offset: offset + perPage, perPage }) : null,
      meta: LOCAL_META,
    };
  }

  async function character(userId: string, characterId: string): Promise<CharacterResponse> {
    if (!UUID.test(characterId)) throw notFound();
    const adult = await adultFor(userId);
    const found = await db.character.findUnique({
      where: { id: characterId },
      select: {
        id: true,
        name: true,
        nativeName: true,
        imageUrl: true,
        description: true,
        voiceActors: { select: voiceActorSelect },
        titles: {
          where: { title: visible(adult) },
          select: { role: true, title: { select: { ...cardSelect(userId), popularity: true } } },
        },
      },
    });
    if (found === null || found.titles.length === 0) throw notFound();
    const appearances = found.titles
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          (b.title.popularity ?? 0) - (a.title.popularity ?? 0) ||
          a.title.id.localeCompare(b.title.id),
      )
      .slice(0, CHARACTER_APPEARANCES_MAX)
      .map((row) => ({ role: row.role, title: toCard(row.title) }));
    return {
      data: {
        id: found.id,
        name: found.name,
        nativeName: found.nativeName,
        imageUrl: found.imageUrl,
        description: found.description,
        voiceActors: toVoiceActors(found.voiceActors),
        appearances,
      },
      meta: LOCAL_META,
    };
  }

  return { franchise, studio, studioTitles, character };
}
