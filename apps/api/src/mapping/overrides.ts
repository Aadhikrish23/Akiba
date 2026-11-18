import type { DbClient, ExternalSource } from '../db/index.js';
import { lock } from './linking.js';

/** A manual override that cannot be applied as asked. The message says what to fix. */
export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverrideError';
  }
}

export interface OverrideInput {
  readonly source: ExternalSource;
  readonly externalId: string;
  readonly titleId: string;
}

/**
 * Pin an external ID to a title (doc 05 §5: "manual override wins over dataset values").
 * Records the override AND moves the ID there, so the tables agree; the override then stops the
 * dataset importer and the resolver from moving it back. A title may hold only one ID per source,
 * so pinning an ID to a title that already has a different one at that source is refused: the
 * operator must free that ID first.
 */
export async function setOverride(db: DbClient, input: OverrideInput): Promise<void> {
  await db.$transaction(async (tx) => {
    await lock(tx, [input]);
    const title = await tx.title.findUnique({ where: { id: input.titleId }, select: { id: true } });
    if (title === null) throw new OverrideError(`title ${input.titleId} does not exist`);

    const rival = await tx.titleExternalId.findFirst({
      where: {
        titleId: input.titleId,
        source: input.source,
        NOT: { externalId: input.externalId },
      },
    });
    if (rival !== null) {
      throw new OverrideError(
        `title ${input.titleId} already has ${input.source} ID ${rival.externalId}; remove or move that ID first`,
      );
    }

    await tx.mappingOverride.upsert({
      where: { source_externalId: { source: input.source, externalId: input.externalId } },
      create: input,
      update: { titleId: input.titleId },
    });
    await tx.titleExternalId.upsert({
      where: { source_externalId: { source: input.source, externalId: input.externalId } },
      create: input,
      update: { titleId: input.titleId },
    });
  });
}

/** Remove an override. The ID stays where it is; from now on the normal rules apply again. */
export async function removeOverride(
  db: DbClient,
  source: ExternalSource,
  externalId: string,
): Promise<boolean> {
  const result = await db.mappingOverride.deleteMany({ where: { source, externalId } });
  return result.count > 0;
}
