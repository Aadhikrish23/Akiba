import { createHash, randomBytes } from 'node:crypto';
import {
  EXPORT_VERSION,
  type Profile,
  type ShareCreated,
  type ShareScope,
  type ShareStatus,
  type SharedListResponse,
  type UpdateProfileRequest,
} from '@akiba/shared';
import type { DbClient } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { decodeOffset, encodeOffset } from '../library/cursor.js';
import { effectiveTotal } from '../library/view.js';
import { cardSelect, toCard } from '../titles/catalog.js';
import type { AuthService } from '../auth/index.js';

export interface AccountService {
  updateProfile(userId: string, request: UpdateProfileRequest): Promise<Profile>;
  exportJson(userId: string): Promise<ExportFile>;
  exportCsv(userId: string): Promise<string>;
  getShare(userId: string): Promise<ShareStatus>;
  /** Creates the link, or replaces it (the old URL stops working at once). */
  putShare(userId: string, scope: ShareScope): Promise<ShareCreated>;
  revokeShare(userId: string): Promise<void>;
  /** The public view. Every kind of failure is the same 404. */
  sharedList(
    token: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<SharedListResponse>;
}

export interface AccountServiceOptions {
  readonly db: DbClient;
  readonly auth: AuthService;
  /** Origin of the web app; share URLs are built from it. */
  readonly webBaseUrl: string;
  readonly now?: () => Date;
}

/** The file `POST /me/export` returns (FR-EXPT-001/002). Everything the user did, nothing of anyone else's. */
export interface ExportFile {
  readonly exportVersion: number;
  readonly exportedAt: string;
  readonly user: {
    readonly email: string;
    readonly displayName: string | null;
    readonly createdAt: string;
  };
  readonly settings: {
    readonly titleLanguage: string;
    readonly timeZone: string;
    readonly libraryView: string;
    readonly alertsEnabled: boolean;
    readonly showAdult: boolean;
  };
  readonly entries: readonly ExportEntry[];
  readonly events: readonly ExportEvent[];
  /** IDs (within this file) of the entries marked as favourites. */
  readonly favorites: readonly string[];
}

interface ExportEntry {
  readonly id: string;
  /** Enough to find the title again at any source, whatever Akiba's own IDs become. */
  readonly title: {
    readonly akibaId: string;
    readonly externalIds: readonly { readonly source: string; readonly externalId: string }[];
    readonly romaji: string | null;
    readonly english: string | null;
    readonly native: string | null;
    readonly kind: string;
    readonly seasonYear: number | null;
  };
  readonly status: string;
  readonly progress: number;
  readonly episodesTotalOverride: number | null;
  readonly rating: number | null;
  readonly review: string | null;
  readonly notes: string | null;
  readonly isFavorite: boolean;
  readonly alertsEnabled: boolean | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly addedAt: string;
  readonly updatedAt: string;
  /** Set when the title was removed from the library; the history is kept. */
  readonly removedAt: string | null;
  readonly runs: readonly {
    readonly runNumber: number;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly rating: number | null;
    readonly progressAtEnd: number | null;
  }[];
}

interface ExportEvent {
  readonly id: string;
  readonly entryId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly runNumber: number | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A viewer ID no user has: the card's "your status" join finds nothing, so it stays null. */
const NOBODY = '00000000-0000-0000-0000-000000000000';

type StoredScope = {
  statuses: ShareScope['statuses'];
  show_ratings: boolean;
  show_reviews: boolean;
};

const toStored = (scope: ShareScope): StoredScope => ({
  statuses: scope.statuses,
  show_ratings: scope.showRatings,
  show_reviews: scope.showReviews,
});
const fromStored = (value: unknown): ShareScope => {
  const stored = value as StoredScope;
  return {
    statuses: stored.statuses,
    showRatings: stored.show_ratings,
    showReviews: stored.show_reviews,
  };
};

/**
 * A spreadsheet treats a cell that starts with = + - @ as a formula. A title or note someone typed
 * (or a source supplied) must not be able to run one when the export is opened, so such cells are
 * prefixed with an apostrophe, and every cell is quoted when it contains a delimiter.
 */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  const { db, auth, webBaseUrl } = options;
  const now = options.now ?? (() => new Date());

  async function updateProfile(userId: string, request: UpdateProfileRequest): Promise<Profile> {
    await db.user.update({
      where: { id: userId },
      data: {
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        ...(request.titleLanguage === undefined ? {} : { titleLanguage: request.titleLanguage }),
        ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
        ...(request.libraryView === undefined ? {} : { libraryView: request.libraryView }),
        ...(request.alertsEnabled === undefined ? {} : { alertsEnabled: request.alertsEnabled }),
        ...(request.showAdult === undefined ? {} : { showAdult: request.showAdult }),
      },
    });
    const profile = await auth.getProfile(userId);
    if (profile === null) throw notFound();
    return profile;
  }

  // ── Export ───────────────────────────────────────────────────────────────────────

  async function exportJson(userId: string): Promise<ExportFile> {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const entries = await db.libraryEntry.findMany({
      where: { userId },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      include: {
        runs: { orderBy: { runNumber: 'asc' } },
        title: { include: { externalIds: true } },
      },
    });
    const events = await db.event.findMany({
      where: { userId },
      orderBy: [{ occurredAt: 'asc' }, { seq: 'asc' }],
      select: { id: true, entryId: true, type: true, payload: true, occurredAt: true, runId: true },
    });
    const runNumbers = new Map<string, number>();
    for (const entry of entries)
      for (const run of entry.runs) runNumbers.set(run.id, run.runNumber);

    return {
      exportVersion: EXPORT_VERSION,
      exportedAt: now().toISOString(),
      user: {
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt.toISOString(),
      },
      settings: {
        titleLanguage: user.titleLanguage,
        timeZone: user.timeZone,
        libraryView: user.libraryView,
        alertsEnabled: user.alertsEnabled,
        showAdult: user.showAdult,
      },
      entries: entries.map((entry) => ({
        id: entry.id,
        title: {
          akibaId: entry.titleId,
          externalIds: entry.title.externalIds
            .map((row) => ({ source: row.source, externalId: row.externalId }))
            .sort((a, b) => a.source.localeCompare(b.source)),
          romaji: entry.title.titleRomaji,
          english: entry.title.titleEnglish,
          native: entry.title.titleNative,
          kind: entry.title.kind,
          seasonYear: entry.title.seasonYear,
        },
        status: entry.status,
        progress: entry.progress,
        episodesTotalOverride: entry.episodesTotalOverride,
        rating: entry.rating,
        review: entry.review,
        notes: entry.notes,
        isFavorite: entry.isFavorite,
        alertsEnabled: entry.alertsEnabled,
        startedAt: iso(entry.startedAt),
        completedAt: iso(entry.completedAt),
        addedAt: entry.addedAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
        removedAt: iso(entry.removedAt),
        runs: entry.runs.map((run) => ({
          runNumber: run.runNumber,
          startedAt: run.startedAt.toISOString(),
          finishedAt: iso(run.finishedAt),
          rating: run.rating,
          progressAtEnd: run.progressAtEnd,
        })),
      })),
      events: events.map((event) => ({
        id: event.id,
        entryId: event.entryId,
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt.toISOString(),
        runNumber: event.runId === null ? null : (runNumbers.get(event.runId) ?? null),
      })),
      favorites: entries
        .filter((entry) => entry.isFavorite && entry.removedAt === null)
        .map((entry) => entry.id),
    };
  }

  const CSV_COLUMNS = [
    'title_romaji',
    'title_english',
    'title_native',
    'format',
    'season_year',
    'anilist_id',
    'mal_id',
    'status',
    'progress',
    'episodes_total',
    'rating',
    'favorite',
    'started_at',
    'completed_at',
    'added_at',
    'updated_at',
    'notes',
    'review',
  ] as const;

  async function exportCsv(userId: string): Promise<string> {
    const entries = await db.libraryEntry.findMany({
      where: { userId, removedAt: null },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      include: { title: { include: { externalIds: true } } },
    });
    const lines = [CSV_COLUMNS.join(',')];
    for (const entry of entries) {
      const ext = (source: string): string | null =>
        entry.title.externalIds.find((row) => row.source === source)?.externalId ?? null;
      const cells: (string | number | boolean | null)[] = [
        entry.title.titleRomaji,
        entry.title.titleEnglish,
        entry.title.titleNative,
        entry.title.kind,
        entry.title.seasonYear,
        ext('anilist'),
        ext('mal'),
        entry.status,
        entry.progress,
        effectiveTotal(entry.episodesTotalOverride, entry.title.episodesTotal),
        entry.rating,
        entry.isFavorite,
        iso(entry.startedAt),
        iso(entry.completedAt),
        entry.addedAt.toISOString(),
        entry.updatedAt.toISOString(),
        entry.notes,
        entry.review,
      ];
      lines.push(cells.map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  // ── Share link ───────────────────────────────────────────────────────────────────

  async function getShare(userId: string): Promise<ShareStatus> {
    const link = await db.shareLink.findUnique({ where: { userId } });
    if (link === null || link.revokedAt !== null)
      return { active: false, scope: null, createdAt: null };
    return { active: true, scope: fromStored(link.scope), createdAt: link.createdAt.toISOString() };
  }

  async function putShare(userId: string, scope: ShareScope): Promise<ShareCreated> {
    // 256 random bits. Only their SHA-256 is stored, so the database cannot reveal a live link.
    const token = randomBytes(32).toString('base64url');
    const at = now();
    const data = {
      tokenHash: hashToken(token),
      scope: toStored(scope),
      createdAt: at,
      revokedAt: null,
    };
    await db.shareLink.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return {
      token,
      url: `${webBaseUrl}/shared/${token}`,
      scope,
      createdAt: at.toISOString(),
    };
  }

  async function revokeShare(userId: string): Promise<void> {
    await db.shareLink.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now() },
    });
  }

  async function sharedList(
    token: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<SharedListResponse> {
    if (!TOKEN_PATTERN.test(token)) throw notFound();
    const link = await db.shareLink.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { displayName: true, deletedAt: true } } },
    });
    // Unknown, revoked, or the owner is being deleted: one answer for all of them.
    if (link === null || link.revokedAt !== null || link.user.deletedAt !== null) throw notFound();

    const scope = fromStored(link.scope);
    const offset = decodeOffset(query.cursor);
    const rows = await db.libraryEntry.findMany({
      where: {
        userId: link.userId,
        removedAt: null,
        status: { in: [...scope.statuses] },
        // Adult-rated titles are not shown on a public page (Q-10).
        title: { isAdult: false },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: offset,
      take: query.limit + 1,
      select: {
        status: true,
        progress: true,
        episodesTotalOverride: true,
        isFavorite: true,
        rating: true,
        review: true,
        updatedAt: true,
        title: { select: cardSelect(NOBODY) },
      },
    });
    return {
      owner: { displayName: link.user.displayName },
      scope,
      data: rows.slice(0, query.limit).map((row) => ({
        title: toCard(row.title),
        status: row.status,
        progress: row.progress,
        effectiveTotal: effectiveTotal(row.episodesTotalOverride, row.title.episodesTotal),
        isFavorite: row.isFavorite,
        // Withheld, not nulled, when the owner did not choose to show them: absence says nothing.
        ...(scope.showRatings ? { rating: row.rating } : {}),
        ...(scope.showReviews ? { review: row.review } : {}),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > query.limit ? encodeOffset(offset + query.limit) : null,
    };
  }

  return { updateProfile, exportJson, exportCsv, getShare, putShare, revokeShare, sharedList };
}
