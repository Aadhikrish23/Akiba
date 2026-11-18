import type { ExternalSource } from '../db/index.js';
import type { ExternalIds } from '../sources/types.js';

/** One ID of one title at one source: the unit the mapping tables are keyed by. */
export interface ExternalRef {
  readonly source: ExternalSource;
  readonly externalId: string;
}

/**
 * Which source's ID is trusted first when several disagree. AniList is the primary source (D-02),
 * so an AniList ID IS the identity of a title; MAL and Kitsu IDs are cross-references to it.
 */
export const SOURCE_PRIORITY: readonly ExternalSource[] = ['anilist', 'mal', 'kitsu'];

export const refKey = (ref: ExternalRef): string => `${ref.source}:${ref.externalId}`;

const ID_PATTERN = /^[0-9]{1,12}$/;

/** The IDs a source reported, as refs in priority order. Anything that is not a plain number is dropped. */
export function refsOf(ids: ExternalIds): ExternalRef[] {
  const refs: ExternalRef[] = [];
  for (const source of SOURCE_PRIORITY) {
    const value = (ids as Partial<Record<ExternalSource, string>>)[source];
    if (value !== undefined && ID_PATTERN.test(value)) refs.push({ source, externalId: value });
  }
  return refs;
}

/** Order-independent form of a pair, for de-duplicating conflicts. */
export function pairKey(a: ExternalRef, b: ExternalRef): string {
  return [refKey(a), refKey(b)].sort().join('|');
}
