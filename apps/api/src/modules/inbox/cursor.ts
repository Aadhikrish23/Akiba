import { z } from 'zod';
import { invalidCursor } from '../../lib/errors.js';

/** The inbox is newest first; a cursor says where the last page ended (time, then ID to break ties). */
const schema = z.object({ k: z.literal('inbox'), t: z.iso.datetime(), id: z.uuid() });
export interface InboxCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(
    JSON.stringify({ k: 'inbox', t: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/** Undefined for the first page; a 422 for a cursor that is not ours. */
export function decodeInboxCursor(value: string | undefined): InboxCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (parsed.success) return { createdAt: new Date(parsed.data.t), id: parsed.data.id };
  } catch {
    // fall through
  }
  throw invalidCursor();
}
