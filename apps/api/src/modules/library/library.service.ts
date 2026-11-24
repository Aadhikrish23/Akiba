import type {
  AddToLibraryRequest,
  EntryStatus,
  LibraryCounts,
  LibraryEntryDetail,
  LibraryListQuery,
  LibraryListResponse,
  EpisodesTotalRequest,
  ProgressRequest,
  ProgressResponse,
  UpdateEntryRequest,
} from '@akiba/shared';
import { Prisma, type DbClient, type DbTransaction } from '../../db/index.js';
import {
  alreadyInLibrary,
  entryCompleted,
  notCompleted,
  notFound,
  progressBelowZero,
  progressExceedsAired,
  progressExceedsTotal,
  totalBelowProgress,
} from '../../lib/errors.js';
import { EventWriter } from './events.js';
import { decodeOffset, encodeOffset } from './cursor.js';
import {
  effectiveTotal,
  entrySelect,
  episodesAired,
  toDetail,
  toEntry,
  type EntryRow,
} from './view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LibraryService {
  list(userId: string, query: LibraryListQuery): Promise<LibraryListResponse>;
  favorites(userId: string, query: LibraryListQuery): Promise<LibraryListResponse>;
  counts(userId: string): Promise<LibraryCounts>;
  get(userId: string, entryId: string): Promise<LibraryEntryDetail>;
  add(userId: string, request: AddToLibraryRequest): Promise<LibraryEntryDetail>;
  update(userId: string, entryId: string, request: UpdateEntryRequest): Promise<LibraryEntryDetail>;
  remove(userId: string, entryId: string): Promise<void>;
  /** FR-TRK-001…004, -007, -008: +1 / -1 / set; Planned → Watching on the first episode. */
  progress(userId: string, entryId: string, request: ProgressRequest): Promise<ProgressResponse>;
  /** FR-TRK-005: the user's own episode count (visible and resettable). */
  setEpisodesTotal(
    userId: string,
    entryId: string,
    request: EpisodesTotalRequest,
  ): Promise<LibraryEntryDetail>;
  clearEpisodesTotal(userId: string, entryId: string): Promise<LibraryEntryDetail>;
  /** FR-REM-004: a new run of a completed title; earlier runs are kept. */
  startRun(userId: string, entryId: string): Promise<LibraryEntryDetail>;
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
    lock = false,
  ): Promise<DetailRow> {
    if (!UUID.test(entryId)) throw notFound();
    if (lock) {
      // Two requests on one entry (a double-tapped +1, two devices) take turns: each reads the
      // state the other left, so no update is lost. Waits only on the same entry's row.
      await client.$queryRaw`
        SELECT id FROM library_entry
        WHERE id = ${entryId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL
        FOR UPDATE`;
    }
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
      const viewer = await tx.user.findUnique({
        where: { id: userId },
        select: { showAdult: true },
      });
      const title = await tx.title.findFirst({
        // An adult-rated title can be added only by someone who turned adult titles on (Q-10).
        where: { id: request.titleId, ...(viewer?.showAdult === true ? {} : { isAdult: false }) },
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
      // The entry's progress changes with the new run (back to 0, or to the total when added
      // as Completed): the events must explain it, so the history and the state always agree.
      const fromProgress = existing?.progress ?? 0;
      if (progress !== fromProgress) {
        await events.write({
          userId,
          entryId,
          titleId: title.id,
          runId: run.id,
          type: 'progress_changed',
          payload: { from: fromProgress, to: progress, run: runNumber },
        });
      }
      if (completed) {
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
      const entry = await loadActive(tx, userId, entryId, true);
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
      if (request.rating !== undefined && request.rating !== entry.rating) {
        data.rating = request.rating;
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          type: 'rated',
          payload: { from: entry.rating, to: request.rating },
        });
        // The rating also belongs to the run it was given in (FR-REM-005).
        const latest = [...entry.runs].sort((a, b) => b.runNumber - a.runNumber)[0];
        if (latest !== undefined) {
          await tx.viewingRun.update({
            where: { id: latest.id },
            data: { rating: request.rating },
          });
        }
      }
      if (request.review !== undefined) {
        const next =
          request.review === null || request.review.trim() === '' ? null : request.review;
        if (next !== entry.review) {
          data.review = next;
          // Only the length is recorded: the text lives on the entry (doc 06 §3).
          await events.write({
            userId,
            entryId: entry.id,
            titleId: entry.titleId,
            type: 'reviewed',
            payload: { length: next === null ? 0 : next.length },
          });
        }
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
      const entry = await loadActive(tx, userId, entryId, true);
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

  // ── Tracking ────────────────────────────────────────────────────────────────────

  const currentRunOf = (entry: DetailRow) =>
    [...entry.runs].sort((a, b) => b.runNumber - a.runNumber)[0];

  async function progress(
    userId: string,
    entryId: string,
    request: ProgressRequest,
  ): Promise<ProgressResponse> {
    const suggestComplete = await db.$transaction(async (tx) => {
      const entry = await loadActive(tx, userId, entryId, true);
      // A completed entry's run is closed. Logging an episode there would silently reopen it.
      if (entry.status === 'completed') throw entryCompleted();

      const total = effectiveTotal(entry.episodesTotalOverride, entry.title.episodesTotal);
      const from = entry.progress;
      const to = 'delta' in request ? from + request.delta : request.set;
      if (to < 0) throw progressBelowZero();
      // FR-TRK-007: never past a known total; the user raises the count if the source is wrong.
      if (total !== null && to > total) throw progressExceedsTotal(total);
      // A running show with no known total: not past what has aired, unless the count is already
      // there (an old entry, or one added before the airing times were known).
      if (total === null && to > from) {
        const aired = episodesAired(entry.title, now());
        if (aired !== null && to > aired) throw progressExceedsAired(aired);
      }
      if (to === from) return total !== null && to === total;

      const at = now();
      const events = new EventWriter(tx, at);
      const data: Prisma.LibraryEntryUncheckedUpdateInput = { progress: to };
      let run = currentRunOf(entry);
      if (run === undefined || run.finishedAt !== null) {
        // Defensive: an active, non-completed entry always has an open run. If one is missing,
        // make it rather than lose the episode.
        const created = await tx.viewingRun.create({
          data: { entryId: entry.id, runNumber: (run?.runNumber ?? 0) + 1, startedAt: at },
          select: {
            id: true,
            runNumber: true,
            startedAt: true,
            finishedAt: true,
            rating: true,
            progressAtEnd: true,
          },
        });
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          runId: created.id,
          type: 'run_started',
          payload: { run_number: created.runNumber },
        });
        run = created;
      }

      await events.write({
        userId,
        entryId: entry.id,
        titleId: entry.titleId,
        runId: run.id,
        type: 'progress_changed',
        payload: { from, to, run: run.runNumber },
      });

      // FR-TRK-004: the first episode of a Planned entry starts it. Watching an episode of a
      // paused or dropped one picks it up again.
      const resumes =
        to > from &&
        (entry.status === 'planned' || entry.status === 'on_hold' || entry.status === 'dropped');
      if (resumes) {
        data.status = 'watching';
        if (entry.startedAt === null) data.startedAt = at;
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          type: 'status_changed',
          payload: { from: entry.status, to: 'watching' },
        });
      }
      await tx.libraryEntry.update({ where: { id: entry.id }, data: { ...data, updatedAt: at } });
      return total !== null && to === total;
    });
    return { data: await get(userId, entryId), suggestComplete };
  }

  async function setEpisodesTotal(
    userId: string,
    entryId: string,
    request: EpisodesTotalRequest,
  ): Promise<LibraryEntryDetail> {
    await db.$transaction(async (tx) => {
      const entry = await loadActive(tx, userId, entryId, true);
      // The invariant is progress <= total. Lowering the count below it is refused, not clamped:
      // silently dropping watched episodes would lose what the user did.
      if (request.total < entry.progress) throw totalBelowProgress(entry.progress);
      if (entry.episodesTotalOverride === request.total) return;
      const at = now();
      await tx.libraryEntry.update({
        where: { id: entry.id },
        data: { episodesTotalOverride: request.total, updatedAt: at },
      });
      await new EventWriter(tx, at).write({
        userId,
        entryId: entry.id,
        titleId: entry.titleId,
        type: 'total_overridden',
        payload: {
          from: effectiveTotal(entry.episodesTotalOverride, entry.title.episodesTotal),
          to: request.total,
        },
      });
    });
    return get(userId, entryId);
  }

  async function clearEpisodesTotal(userId: string, entryId: string): Promise<LibraryEntryDetail> {
    await db.$transaction(async (tx) => {
      const entry = await loadActive(tx, userId, entryId, true);
      if (entry.episodesTotalOverride === null) return; // nothing to reset
      const source = entry.title.episodesTotal;
      if (source !== null && source < entry.progress) throw totalBelowProgress(entry.progress);
      const at = now();
      await tx.libraryEntry.update({
        where: { id: entry.id },
        data: { episodesTotalOverride: null, updatedAt: at },
      });
      await new EventWriter(tx, at).write({
        userId,
        entryId: entry.id,
        titleId: entry.titleId,
        type: 'total_override_cleared',
        payload: { from: entry.episodesTotalOverride, to: source },
      });
    });
    return get(userId, entryId);
  }

  async function startRun(userId: string, entryId: string): Promise<LibraryEntryDetail> {
    await db.$transaction(async (tx) => {
      const entry = await loadActive(tx, userId, entryId, true);
      if (entry.status !== 'completed') throw notCompleted();
      const at = now();
      const events = new EventWriter(tx, at);
      const last = currentRunOf(entry);
      const runNumber = (last?.runNumber ?? 0) + 1;
      // The finished run stays exactly as it is; the entry's live fields start over for the new one.
      const run = await tx.viewingRun.create({
        data: { entryId: entry.id, runNumber, startedAt: at },
        select: { id: true },
      });
      await tx.libraryEntry.update({
        where: { id: entry.id },
        data: { status: 'watching', progress: 0, completedAt: null, updatedAt: at },
      });
      await events.write({
        userId,
        entryId: entry.id,
        titleId: entry.titleId,
        type: 'status_changed',
        payload: { from: 'completed', to: 'watching' },
      });
      if (entry.progress > 0) {
        await events.write({
          userId,
          entryId: entry.id,
          titleId: entry.titleId,
          runId: run.id,
          type: 'progress_changed',
          payload: { from: entry.progress, to: 0, run: runNumber },
        });
      }
      await events.write({
        userId,
        entryId: entry.id,
        titleId: entry.titleId,
        runId: run.id,
        type: 'run_started',
        payload: { run_number: runNumber },
      });
    });
    return get(userId, entryId);
  }

  async function counts(userId: string): Promise<LibraryCounts> {
    const groups = await db.libraryEntry.groupBy({
      by: ['status'],
      where: { userId, removedAt: null },
      _count: { _all: true },
    });
    const favorites = await db.libraryEntry.count({
      where: { userId, removedAt: null, isFavorite: true },
    });
    const result: LibraryCounts = {
      watching: 0,
      completed: 0,
      planned: 0,
      on_hold: 0,
      dropped: 0,
      favorites,
    };
    for (const group of groups) result[group.status] = group._count._all;
    return result;
  }

  return {
    counts,
    progress,
    setEpisodesTotal,
    clearEpisodesTotal,
    startRun,
    list: (userId, query) => list(userId, query),
    favorites: (userId, query) => list(userId, query, true),
    get,
    add,
    update,
    remove,
  };
}
