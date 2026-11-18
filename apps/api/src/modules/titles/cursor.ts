import { z } from 'zod';
import { invalidCursor } from '../../lib/errors.js';

/**
 * Pagination cursors (doc 07 §1) are opaque to clients. Ours say which kind of list they belong
 * to and where it continues: a source page number, or an offset into the local cache (used when
 * no source can be asked). The page size travels in the cursor so that changing `limit` between
 * pages cannot skip or repeat titles.
 */
const cursorSchema = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('remote'),
    page: z.number().int().min(1).max(10_000),
    perPage: z.number().int().min(1).max(50),
  }),
  z.object({
    k: z.literal('local'),
    offset: z.number().int().min(0).max(1_000_000),
    perPage: z.number().int().min(1).max(100),
  }),
]);

export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Undefined when there is no cursor (the first page); a 422 for one that is not ours. */
export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw invalidCursor();
}
