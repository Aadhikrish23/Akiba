import type {
  InboxListResponse,
  InboxQuery,
  Notification,
  NotificationResponse,
  ReadAllResponse,
  UnreadCountResponse,
} from '@akiba/shared';
import type { DbClient, Prisma } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { cardSelect, toCard } from '../titles/catalog.js';
import { decodeInboxCursor, encodeInboxCursor } from './cursor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InboxService {
  list(userId: string, query: InboxQuery): Promise<InboxListResponse>;
  unreadCount(userId: string): Promise<UnreadCountResponse>;
  markRead(userId: string, notificationId: string): Promise<NotificationResponse>;
  markAllRead(userId: string): Promise<ReadAllResponse>;
  remove(userId: string, notificationId: string): Promise<void>;
}

/**
 * The Inbox (FR-NOTE-003). Every query is scoped by the caller's ID, so another user's
 * notification is simply 404. Adult-rated titles are left out unless the user turned them on
 * (Q-10): a title the user cannot open must not show up in their inbox either.
 */
export function createInboxService(options: {
  readonly db: DbClient;
  readonly now?: () => Date;
}): InboxService {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  const rowSelect = (userId: string) =>
    ({
      id: true,
      kind: true,
      createdAt: true,
      readAt: true,
      episode: { select: { episodeNumber: true, airsAt: true } },
      title: { select: cardSelect(userId) },
    }) satisfies Prisma.NotificationSelect;
  type Row = Prisma.NotificationGetPayload<{ select: ReturnType<typeof rowSelect> }>;

  const toNotification = (row: Row): Notification => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    episode: { number: row.episode.episodeNumber, airsAt: row.episode.airsAt.toISOString() },
    title: toCard(row.title),
  });

  async function adultFor(userId: string): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { showAdult: true } });
    return user?.showAdult === true;
  }
  const visible = (adult: boolean): Prisma.NotificationWhereInput =>
    adult ? {} : { title: { isAdult: false } };

  async function list(userId: string, query: InboxQuery): Promise<InboxListResponse> {
    const adult = await adultFor(userId);
    const cursor = decodeInboxCursor(query.cursor);
    const rows = await db.notification.findMany({
      where: {
        userId,
        ...(query.unread === true ? { readAt: null } : {}),
        ...visible(adult),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      select: rowSelect(userId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toNotification),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeInboxCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async function unreadCount(userId: string): Promise<UnreadCountResponse> {
    const adult = await adultFor(userId);
    const count = await db.notification.count({
      where: { userId, readAt: null, ...visible(adult) },
    });
    return { data: { count } };
  }

  /** The caller's own, visible notification; 404 for anything else (one answer for all reasons). */
  async function own(userId: string, id: string): Promise<Row> {
    if (!UUID.test(id)) throw notFound();
    const row = await db.notification.findFirst({
      where: { id, userId, ...visible(await adultFor(userId)) },
      select: rowSelect(userId),
    });
    if (row === null) throw notFound();
    return row;
  }

  async function markRead(userId: string, id: string): Promise<NotificationResponse> {
    const row = await own(userId, id);
    // Already read: keep the first time it was read (the call is idempotent).
    if (row.readAt === null) {
      await db.notification.updateMany({
        where: { id: row.id, userId, readAt: null },
        data: { readAt: now() },
      });
    }
    return { data: toNotification(await own(userId, id)) };
  }

  async function markAllRead(userId: string): Promise<ReadAllResponse> {
    const result = await db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: now() },
    });
    return { data: { updated: result.count } };
  }

  async function remove(userId: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw notFound();
    const result = await db.notification.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw notFound();
  }

  return { list, unreadCount, markRead, markAllRead, remove };
}
