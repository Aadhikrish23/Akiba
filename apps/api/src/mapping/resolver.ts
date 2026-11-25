import { Prisma, type DbClient, type DbTransaction, type ExternalSource } from '../db/index.js';
import type {
  ExternalIds,
  SourceRelationTarget,
  SourceTitle,
  TitleKind,
} from '../sources/types.js';
import { accepts, attach, lock, owners, recordConflict } from './linking.js';
import { SOURCE_PRIORITY, refKey, refsOf, type ExternalRef } from './refs.js';
import { titleColumns } from './titleData.js';

/**
 * Akiba ID resolver (D-03, doc 05 §5). Library entries, events and notifications reference ONLY
 * the Akiba ID; this is where an external ID becomes one.
 *
 * Order: manual override → exact external-ID hit → mapping dataset → create. AniList is the
 * primary source, so an AniList ID is a title's identity and a MAL/Kitsu ID is a cross-reference
 * to it: two AniList entries are two titles even if MAL lists them as one (split-cour), and the
 * disagreement goes to the `mapping_conflict` queue instead of silently merging them.
 */

export type MatchedBy = 'override' | 'external_id' | 'dataset' | 'created';

export interface Resolution {
  readonly titleId: string;
  readonly matchedBy: MatchedBy;
  readonly created: boolean;
  /** Conflicts recorded (or already queued) while resolving this. */
  readonly conflicts: number;
}

export interface ResolveInput {
  readonly externalIds: ExternalIds;
  /** What the source said about the title. Needed to create it; ignored if it already exists. */
  readonly title?: SourceTitle;
  /** Enough to create a placeholder when only a relation edge is known. */
  readonly stub?: {
    readonly title: string;
    readonly kind: TitleKind | null;
    readonly titleEnglish?: string | null;
    readonly coverUrl?: string | null;
  };
}

/** Nothing identifies the title, or it must be created and there is nothing to create it from. */
export class UnresolvableTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvableTitleError';
  }
}

export interface ResolverOptions {
  readonly now?: () => Date;
}

export interface TitleResolver {
  resolve(input: ResolveInput): Promise<Resolution>;
  /** A relation edge: resolved if known, otherwise a placeholder title is created. */
  resolveRelationTarget(target: SourceRelationTarget): Promise<Resolution>;
}

const MAX_ATTEMPTS = 3;

function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002' || error.code === 'P2034';
  }
  return error instanceof Error && /deadlock detected/i.test(error.message);
}

export function createTitleResolver(db: DbClient, options: ResolverOptions = {}): TitleResolver {
  const now = options.now ?? (() => new Date());

  async function datasetRefs(
    tx: DbTransaction,
    refs: readonly ExternalRef[],
  ): Promise<ExternalRef[]> {
    const column = { anilist: 'anilistId', mal: 'malId', kitsu: 'kitsuId' } as const;
    const rows = await tx.mappingDatasetEntry.findMany({
      where: { OR: refs.map((ref) => ({ [column[ref.source]]: ref.externalId })) },
    });
    const known = new Set(refs.map(refKey));
    const extra: ExternalRef[] = [];
    for (const row of rows) {
      const pairs: [ExternalSource, string | null][] = [
        ['anilist', row.anilistId],
        ['mal', row.malId],
        ['kitsu', row.kitsuId],
      ];
      for (const [source, externalId] of pairs) {
        if (externalId === null) continue;
        const ref = { source, externalId };
        if (!known.has(refKey(ref))) {
          known.add(refKey(ref));
          extra.push(ref);
        }
      }
    }
    return extra;
  }

  async function createTitle(
    tx: DbTransaction,
    input: ResolveInput,
    refs: readonly ExternalRef[],
  ): Promise<string> {
    let data: Prisma.TitleUncheckedCreateInput;
    if (input.title !== undefined) {
      data = titleColumns(input.title, now());
    } else if (input.stub !== undefined) {
      // A placeholder: never fetched, so the cache refreshes it the first time it is opened.
      data = {
        kind: input.stub.kind ?? 'tv',
        titleRomaji: input.stub.title,
        titleEnglish: input.stub.titleEnglish ?? null,
        coverUrl: input.stub.coverUrl ?? null,
        status: 'not_yet_released',
        fetchedAt: null,
        stale: true,
      };
    } else {
      throw new UnresolvableTitleError(
        'the title is unknown and nothing was given to create it from',
      );
    }
    const created = await tx.title.create({ data, select: { id: true } });
    // Only IDs nobody owns: a taken one stays with its owner and is queued as a conflict.
    const taken = await owners(tx, refs);
    for (const ref of refs) {
      if (taken.some((row) => row.source === ref.source && row.externalId === ref.externalId))
        continue;
      await tx.titleExternalId.create({
        data: { titleId: created.id, source: ref.source, externalId: ref.externalId },
      });
    }
    return created.id;
  }

  async function resolveOnce(tx: DbTransaction, input: ResolveInput): Promise<Resolution> {
    const refs = refsOf(input.externalIds);
    if (refs.length === 0) throw new UnresolvableTitleError('no usable external ID was given');
    await lock(tx, refs);
    let conflicts = 0;

    // 1. Manual override wins over everything.
    const overrides = await tx.mappingOverride.findMany({
      where: { OR: refs.map((ref) => ({ source: ref.source, externalId: ref.externalId })) },
    });
    const overridden = [...overrides].sort(
      (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source),
    )[0];
    if (overridden !== undefined) {
      conflicts += await attach(tx, overridden.titleId, refs);
      return { titleId: overridden.titleId, matchedBy: 'override', created: false, conflicts };
    }

    // 2. Exact external-ID hit. Candidates in priority order; one that would give a title two IDs
    //    at the same source is rejected and queued, not merged.
    const hits = await owners(tx, refs);
    const candidates = [...hits].sort(
      (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source),
    );
    for (const hit of candidates) {
      const clash = await accepts(tx, hit.titleId, refs);
      if (clash === null) {
        conflicts += await attach(tx, hit.titleId, refs);
        return { titleId: hit.titleId, matchedBy: 'external_id', created: false, conflicts };
      }
      await recordConflict(
        tx,
        { source: hit.source, externalId: hit.externalId },
        clash,
        'two entries of the primary source share an ID at another source (split season?)',
      );
      conflicts += 1;
    }

    // 3. The mapping dataset: other IDs of the same title, and a title may exist under those.
    const extra = await datasetRefs(tx, refs);
    if (extra.length > 0) {
      await lock(tx, extra);
      const all = [...refs, ...extra];
      const found = (await owners(tx, extra)).sort(
        (a, b) => SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source),
      );
      for (const hit of found) {
        if ((await accepts(tx, hit.titleId, refs)) === null) {
          conflicts += await attach(tx, hit.titleId, all);
          return { titleId: hit.titleId, matchedBy: 'dataset', created: false, conflicts };
        }
      }
      const titleId = await createTitle(tx, input, all);
      return { titleId, matchedBy: 'created', created: true, conflicts };
    }

    // 4. Nothing known: create.
    const titleId = await createTitle(tx, input, refs);
    return { titleId, matchedBy: 'created', created: true, conflicts };
  }

  async function resolve(input: ResolveInput): Promise<Resolution> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await db.$transaction((tx) => resolveOnce(tx, input), { timeout: 15_000 });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      }
    }
  }

  return {
    resolve,
    resolveRelationTarget(target) {
      return resolve({
        externalIds: target.externalIds,
        ...(target.title === null
          ? {}
          : {
              stub: {
                title: target.title,
                kind: target.kind,
                titleEnglish: target.titleEnglish ?? null,
                coverUrl: target.coverUrl ?? null,
              },
            }),
      });
    },
  };
}
