import type {
  AddToLibraryRequest,
  EntryStatus,
  LibraryEntryDetail,
  LibraryListQuery,
  LibraryListResponse,
  UpdateEntryRequest,
} from '@akiba/shared';
import { Prisma, type DbClient, type DbTransaction } from '../../db/index.js';
import { alreadyInLibrary, notFound } from '../../lib/errors.js';
import { EventWriter } from './events.js';
import { decodeOffset, encodeOffset } from './cursor.js';
import { effectiveTotal, entrySelect, toDetail, toEntry, type EntryRow } from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LibraryService {
  list(userId: string, query: LibraryListQuery): Promise<LibraryListResponse>;
  favorites(userId: string, query: LibraryListQuery): Promise<LibraryListResponse>;
  get(userId: string, entryId: string): Promise<LibraryEntryDetail>;
  add(userId: string, request: AddToLibraryRequest): Promise<LibraryEntryDetail>;
  update(userId: string, entryId: string, request: UpdateEntryRequest): Promise<LibraryEntryDetail>;
  remove(userId: string, entryId: string): Promise<void>;
}

export interface LibraryServiceOptions {
  readonly db: DbClient;
  readonly now?: () => Date;
}

const DETAIL_SELECT = (userId: string) => ({
  ...entrySelect(userId),
  review: true,
  notes: true,
  titleId: true,
  removedAt: true,
  runs: {
    select: {
      id: true,
      runNumber: true,
      startedAt: true,
      finishedAt: true,
      rating: true,
      progressAtEnd: true,
    },
  },
});

type DetailRow = Prisma.LibraryEntryGetPayload<{ select: ReturnType<typeof DETAIL_SELECT> }>;

export function createLibraryService(options: LibraryServiceOptions): LibraryService {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  /** An entry of THIS user that is on the shelf. Anyone else's, or a removed one, does not exist. */
  async function loadActive(
    client: DbClient | DbTransaction,
    userId: string,
    entryId: string,
  ): Promise<DetailRow> {
    if (!UUID.test(entryId)) throw notFound();
    const row = await client.libraryEntry.findFirst({
      where: { id: entryId, userId, removedAt: null },
      select: DETAIL_SELECT(userId),
    });
    if (row === null) throw notFound();
    return row;
  }

  const detailOf = (row: DetailRow): LibraryEntryDetail => toDetail(row, row.runs);

  // ── Reading ─────────────────────────────────────────────────────────────────────

  async function list(
    userId: string,
    query: LibraryListQuery,
    onlyFavorites = false,
  ): Promise<LibraryListResponse> {
    const offset = decodeOffset(query.cursor);
    const where: Prisma.LibraryEntryWhereInput = {
      userId,
      removedAt: null,
      ...(onlyFavorites ? { isFavorite: true } : {}),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.minRating === undefined ? {} : { rating: { gte: query.minRating } }),
      title: {
        ...(query.format === undefined ? {} : { kind: query.format }),
        ...(query.year === undefined ? {} : { seasonYear: query.year }),
        ...(query.genre === undefined
          ? {}
          : {
              genres: { some: { genre: { name: { equals: query.genre, mode: 'insensitive' } } } },
            }),
        ...(query.q === undefined
          ? {}
          : {
              OR: [
                { titleRomaji: { contains: query.q, mode: 'insensitive' } },
                { titleEnglish: { contains: query.q, mode: 'insensitive' } },
                { titleNative: { contains: query.q, mode: 'insensitive' } },
              ],
            }),
      },
    };

    const direction = (fallback: 'asc' | 'desc'): 'asc' | 'desc' => query.order ?? fallback;
    const orderBy: Prisma.LibraryEntryOrderByWithRelationInput[] =
      query.sort === 'title'
        ? [
            { title: { titleRomaji: { sort: direction('asc'), nulls: 'last' } } },
            { title: { titleEnglish: { sort: direction('asc'), nulls: 'last' } } },
            { id: 'asc' },
          ]
        : query.sort === 'rating'
          ? [
              { rating: { sort: direction('desc'), nulls: 'last' } },
              { updatedAt: 'desc' },
              { id: 'asc' },
            ]
          : query.sort === 'progress'
            ? [{ progress: direction('desc') }, { updatedAt: 'desc' }, { id: 'asc' }]
            : query.sort === 'start_date'
              ? [{ startedAt: { sort: direction('desc'), nulls: 'last' } }, { id: 'asc' }]
              : [{ updatedAt: direction('desc') }, { id: 'asc' }];

    const rows = await db.libraryEntry.findMany({
      where,
      orderBy,
      skip: offset,
      take: query.limit + 1,
      select: entrySelect(userId),
    });
    return {
      data: rows.slice(0, query.limit).map((row: EntryRow) => toEntry(row)),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  async function get(userId: string, entryId: string): Promise<LibraryEntryDetail> {
    return detailOf(await loadActive(db, userId, entryId));
  }

  // ── Adding ──────────────────────────────────────────────────────────────────────

  async function addOnce(userId: string, request: AddToLibraryRequest): Promise<string> {
    return db.$transaction(async (tx) => {
      const title = await tx.title.findFirst({
        where: { id: request.titleId, isAdult: false },
        select: { id: true, episodesTotal: true },
      });
      if (title === null) throw notFound();

      const existing = await tx.libraryEntry.findUnique({
        where: { userId_titleId: { userId, titleId: title.id } },
        select: { id: true, removedAt: true, progress: true, episodesTotalOverride: true },
      });
      if (existing !== null && existing.removedAt === null) throw alreadyInLibrary(existing.id);

      const at = now();
      const events = new EventWriter(tx, at);
      const status = request.status;
      const completed = status === 'completed';
      // A title added as Completed has been watched in full, as far as anyone knows.
      const total = effectiveTotal(existing?.episodesTotalOverride ?? null, title.episodesTotal);
      const progress = completed ? (total ?? 0) : 0;
      const started = status === 'watching' || completed ? at : null;

      let entryId: string;
      let runNumber = 1;
      if (existing === null) {
        const created = await tx.libraryEntry.create({
          data: {
            userId,
            titleId: title.id,
            status,
            progress,
            startedAt: started,
            completedAt: completed ? at : null,
            addedAt: at,
            updatedAt: at,
          },
          select: { id: true },
        });
        entryId = created.id;
      } else {
        // The title was removed before. The entry (and its history) comes back; what happens now
        // is a new run, so earlier runs and events stay exactly as they were.
        entryId = existing.id;
        const last = await tx.viewingRun.aggregate({
          where: { entryId },
          _max: { runNumber: true },
        });
        runNumber = (last._max.runNumber ?? 0) + 1;
        await tx.viewingRun.updateMany({
          where: { entryId, finishedAt: null },
          data: { finishedAt: at, progressAtEnd: existing.progress },
        });
        await tx.libraryEntry.update({
          where: { id: entryId },
          data: {
            status,
            progress,
            removedAt: null,
            startedAt: started,
            completedAt: completed ? at : null,
            rating: null,
            updatedAt: at,
          },
        });
      }

      await events.write({
        userId,
        entryId,
        titleId: title.id,
        type: 'entry_added',
        payload: { status },
      });
      const run = await tx.viewingRun.create({
        data: {
          entryId,
          runNumber,
          startedAt: at,
          finishedAt: completed ? at : null,
          progressAtEnd: completed ? progress : null,
        },
        select: { id: true },
      });
      await events.write({
        userId,
        entryId,
        titleId: title.id,
        runId: run.id,
        type: 'run_started',
        payload: { run_number: runNumber },
      });
      if (completed) {
        if (progress > 0) {
          await events.write({
            userId,
            entryId,
            titleId: title.id,
            runId: run.id,
            type: 'progress_changed',
            payload: { from: 0, to: progress, run: runNumber },
          });
        }
        await events.write({
          userId,
          entryId,
          titleId: title.id,
          runId: run.id,
          type: 'run_completed',
          payload: { run_number: runNumber },
        });
      }
      return entryId;
    });
  }

  async function add(userId: string, request: AddToLibraryRequest): Promise<LibraryEntryDetail> {
    let entryId: string;
    try {
      entryId = await addOnce(userId, request);
    } catch (error) {
      // Two requests for the same title at once: the database let exactly one through.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await db.libraryEntry.findUnique({
          where: { userId_titleId: { userId, titleId: request.titleId } },
          select: { id: true },
        });
        if (winner !== null) throw alreadyInLibrary(winner.id);
      }
      throw error;
    }
    return get(userId, entryId);
  }

  // ── Changing ────────────────────────────────────────────────────────────────────

  /** Status transitions with everything that goes with them (progress, run, dates). */
  async function changeStatus(
    tx: DbTransaction,
    events: EventWriter,
    userId: string,
    entry: DetailRow,
    to: EntryStatus,
    at: Date,
    data: Prisma.LibraryEntryUncheckedUpdateInput,
  ): Promise<void> {
    const from = entry.status;
    data.status = to;
    await events.write({
      userId,
      entryId: entry.id,
      titleId: entry.titleId,
      type: 'status_changed',
      payload: { from, to },
    });

    const currentRun = [...entry.runs].sort((a, b) => b.runNumber - a.runNumber)[0];
    if (to === 'completed') {
      const total = effectiveTotal(entry.episodesTotalOverride, entry.title.episodesTotal);
      const target = total ?? entry.progress;
      if (target !== entry.progress) {
        data.progress = target;
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          runId: currentRun?.id ?? null,
          type: 'progress_changed',
          payload: { from: entry.progress, to: target, run: currentRun?.runNumber ?? 1 },
        });
      }
      data.completedAt = at;
      data.startedAt = entry.startedAt ?? at;
      if (currentRun !== undefined && currentRun.finishedAt === null) {
        await tx.viewingRun.update({
          where: { id: currentRun.id },
          data: { finishedAt: at, progressAtEnd: target },
        });
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          runId: currentRun.id,
          type: 'run_completed',
          payload: { run_number: currentRun.runNumber },
        });
      }
      return;
    }

    if (from === 'completed') {
      // Leaving Completed corrects a mistake or resumes: the run that was closed is open again.
      data.completedAt = null;
      if (currentRun !== undefined && currentRun.finishedAt !== null) {
        await tx.viewingRun.update({
          where: { id: currentRun.id },
          data: { finishedAt: null, progressAtEnd: null },
        });
      }
    }
    if (to === 'watching' && entry.startedAt === null) data.startedAt = at;
  }

  async function update(
    userId: string,
    entryId: string,
    request: UpdateEntryRequest,
  ): Promise<LibraryEntryDetail> {
    await db.$transaction(async (tx) => {
      const entry = await loadActive(tx, userId, entryId);
      const at = now();
      const events = new EventWriter(tx, at);
      const data: Prisma.LibraryEntryUncheckedUpdateInput = {};

      if (request.status !== undefined && request.status !== entry.status) {
        await changeStatus(tx, events, userId, entry, request.status, at, data);
      }
      if (request.isFavorite !== undefined && request.isFavorite !== entry.isFavorite) {
        data.isFavorite = request.isFavorite;
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          type: request.isFavorite ? 'favorited' : 'unfavorited',
        });
      }
      if (request.alertsEnabled !== undefined && request.alertsEnabled !== entry.alertsEnabled) {
        data.alertsEnabled = request.alertsEnabled;
      }
      if (request.notes !== undefined && request.notes !== entry.notes) {
        data.notes = request.notes === null || request.notes.trim() === '' ? null : request.notes;
      }

      // Nothing changed: no write, no event, and `updatedAt` stays (it orders "recently updated").
      if (Object.keys(data).length > 0) {
        await tx.libraryEntry.update({ where: { id: entry.id }, data: { ...data, updatedAt: at } });
      }
    });
    return get(userId, entryId);
  }

  async function remove(userId: string, entryId: string): Promise<void> {
    await db.$transaction(async (tx) => {
      const entry = await loadActive(tx, userId, entryId);
      const at = now();
      const events = new EventWriter(tx, at);
      // A tombstone, not a delete: the entry's events keep a target (doc 06 §3).
      await tx.libraryEntry.update({
        where: { id: entry.id },
        data: { removedAt: at, updatedAt: at },
      });
      await events.write({
        userId,
        entryId: entry.id,
        titleId: entry.titleId,
        type: 'entry_removed',
      });
    });
  }

  return {
    list: (userId, query) => list(userId, query),
    favorites: (userId, query) => list(userId, query, true),
    get,
    add,
    update,
    remove,
  };
}
