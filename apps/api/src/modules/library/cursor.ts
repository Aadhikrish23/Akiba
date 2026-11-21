import { z } from 'zod';
import { invalidCursor } from '../../lib/errors.js';

/** Library lists page by offset: a library is hundreds of rows, and the sort keys vary by request. */
const schema = z.object({ k: z.literal('lib'), offset: z.number().int().min(0).max(1_000_000) });

export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ k: 'lib', offset }), 'utf8').toString('base64url');
}

/** 0 for the first page; a 422 for a cursor that is not ours. */
export function decodeOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data.offset;
  } catch {
    // fall through
  }
  throw invalidCursor();
}
