import type { HistoryItem, HistoryQuery, HistoryResponse } from '@akiba/shared';
import { z } from 'zod';
import type { DbClient, Prisma } from '../../db/index.js';
import { invalidCursor } from '../../lib/errors.js';
import { cardSelect, toCard } from '../titles/catalog.js';

/**
 * The history timeline (FR-REM-003): the user's own events, newest first. Ordering is
 * (`occurred_at`, `seq`) descending; `seq` is the write order, so what happened within one request
 * keeps its order. The cursor is a keyset on exactly those two columns: stable while new events
 * arrive (an offset would shift) and cheap at any depth.
 */
export interface HistoryService {
  list(userId: string, query: HistoryQuery): Promise<HistoryResponse>;
}

const cursorSchema = z.object({ t: z.iso.datetime(), s: z.string().regex(/^\d{1,18}$/) });

function decode(value: string | undefined): { at: Date; seq: bigint } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success) return { at: new Date(parsed.data.t), seq: BigInt(parsed.data.s) };
  } catch {
    // fall through
  }
  throw invalidCursor();
}

const encode = (at: Date, seq: bigint): string =>
  Buffer.from(JSON.stringify({ t: at.toISOString(), s: seq.toString() }), 'utf8').toString(
    'base64url',
  );

export function createHistoryService(db: DbClient): HistoryService {
  return {
    async list(userId, query) {
      const cursor = decode(query.cursor);
      const period: Prisma.DateTimeFilter = {
        ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
        ...(query.to === undefined ? {} : { lt: new Date(query.to) }),
      };
      const where: Prisma.EventWhereInput = {
        userId,
        ...(query.type === undefined ? {} : { type: { in: query.type } }),
        ...(query.titleId === undefined ? {} : { titleId: query.titleId }),
        ...(Object.keys(period).length === 0 ? {} : { occurredAt: period }),
        ...(cursor === undefined
          ? {}
          : {
              AND: [
                {
                  OR: [
                    { occurredAt: { lt: cursor.at } },
                    { occurredAt: cursor.at, seq: { lt: cursor.seq } },
                  ],
                },
              ],
            }),
      };
      const rows = await db.event.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { seq: 'desc' }],
        take: query.limit + 1,
        select: {
          id: true,
          type: true,
          occurredAt: true,
          payload: true,
          entryId: true,
          seq: true,
          title: { select: cardSelect(userId) },
        },
      });
      const page = rows.slice(0, query.limit);
      const data: HistoryItem[] = page.map((row) => ({
        id: row.id,
        type: row.type,
        occurredAt: row.occurredAt.toISOString(),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        entryId: row.entryId,
        title: toCard(row.title),
      }));
      const last = page.at(-1);
      return {
        data,
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encode(last.occurredAt, last.seq)
            : null,
      };
    },
  };
}
