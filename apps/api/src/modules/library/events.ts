import type { DbTransaction, EventType, Prisma } from '../../db/index.js';

/**
 * Events are the append-only memory of what a user did (doc 06 §3, FR-REM-007). Every change to an
 * entry writes its event in the SAME transaction as the change: if the event cannot be written,
 * the change is rolled back (doc 06 §4 invariant 6). Nothing here updates or deletes an event.
 */
export interface EventInput {
  readonly userId: string;
  readonly entryId: string;
  readonly titleId: string;
  readonly runId?: string | null;
  readonly type: EventType;
  readonly payload?: Prisma.InputJsonObject;
}

/**
 * Writes the events of one transaction. They all carry the request's time; the order they were
 * written in is the event's `seq` (a database sequence), which the timeline uses as the tie-break.
 */
export class EventWriter {
  readonly #tx: DbTransaction;
  readonly #at: Date;
  #count = 0;

  constructor(tx: DbTransaction, at: Date) {
    this.#tx = tx;
    this.#at = at;
  }

  async write(event: EventInput): Promise<void> {
    await this.#tx.event.create({
      data: {
        userId: event.userId,
        entryId: event.entryId,
        titleId: event.titleId,
        runId: event.runId ?? null,
        type: event.type,
        payload: event.payload ?? {},
        occurredAt: this.#at,
      },
    });
    this.#count += 1;
  }

  get written(): number {
    return this.#count;
  }
}
