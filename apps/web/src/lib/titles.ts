import { ApiError } from '@akiba/api-client';
import type {
  CatalogMeta,
  EntryStatus,
  TitleCard,
  TitleKind,
  TitleListResponse,
  TitleStatus,
} from '@akiba/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './errors';

/** Display name of a title: romaji by default (doc 08 §8); the title-language setting arrives in T19. */
export function displayTitle(
  title: Pick<TitleCard, 'titleRomaji' | 'titleEnglish' | 'titleNative'>,
): string {
  return title.titleRomaji ?? title.titleEnglish ?? title.titleNative ?? 'Untitled';
}

/** The other names worth showing under the main one. */
export function otherTitles(
  title: Pick<TitleCard, 'titleRomaji' | 'titleEnglish' | 'titleNative'>,
): { text: string; lang: 'en' | 'ja' | undefined }[] {
  const main = displayTitle(title);
  const out: { text: string; lang: 'en' | 'ja' | undefined }[] = [];
  if (title.titleEnglish !== null && title.titleEnglish !== main) {
    out.push({ text: title.titleEnglish, lang: 'en' });
  }
  if (title.titleNative !== null && title.titleNative !== main) {
    out.push({ text: title.titleNative, lang: 'ja' });
  }
  return out;
}

export const KIND_LABEL: Readonly<Record<TitleKind, string>> = {
  tv: 'TV',
  movie: 'Movie',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  tv_short: 'TV short',
  music: 'Music video',
};

export const STATUS_LABEL: Readonly<Record<TitleStatus, string>> = {
  finished: 'Finished',
  releasing: 'Airing',
  not_yet_released: 'Not yet released',
  cancelled: 'Cancelled',
  hiatus: 'On hiatus',
};

export const ENTRY_LABEL: Readonly<Record<EntryStatus, string>> = {
  watching: 'Watching',
  completed: 'Completed',
  planned: 'Planned',
  on_hold: 'On hold',
  dropped: 'Dropped',
};

export const SEASON_LABEL = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Fall',
} as const;

/** "TV · 25 episodes · Spring 2013": what a card shows under the name. */
export function metaLine(title: TitleCard): string {
  const parts: string[] = [KIND_LABEL[title.kind]];
  if (title.episodesTotal !== null) {
    parts.push(`${title.episodesTotal} ${title.episodesTotal === 1 ? 'episode' : 'episodes'}`);
  }
  if (title.seasonYear !== null) {
    parts.push(
      title.season === null
        ? String(title.seasonYear)
        : `${SEASON_LABEL[title.season]} ${title.seasonYear}`,
    );
  }
  return parts.join(' · ');
}

// ── Loading a cursor-paginated list ───────────────────────────────────────────

export type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string; readonly unavailable: boolean }
  | {
      readonly phase: 'ready';
      readonly items: readonly TitleCard[];
      readonly meta: CatalogMeta;
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
      readonly moreError: string | null;
    };

/**
 * Load the first page of a list when `key` changes (a new search, a new filter), and further
 * pages on demand. A response for a request that has since been replaced is dropped, so a slow
 * old search can never overwrite a newer one.
 */
export function useTitleList(
  key: string,
  fetchPage: (cursor: string | undefined) => Promise<TitleListResponse>,
): { state: ListState; loadMore: () => void; retry: () => void } {
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const mine = ++generation.current;
    cursor.current = null;
    setState({ phase: 'loading' });
    fetchRef
      .current(undefined)
      .then((response) => {
        if (mine !== generation.current) return;
        cursor.current = response.nextCursor;
        setState({
          phase: 'ready',
          items: response.data,
          meta: response.meta,
          hasMore: response.nextCursor !== null,
          loadingMore: false,
          moreError: null,
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        setState({
          phase: 'error',
          message: listError(error),
          unavailable: error instanceof ApiError && error.code === 'SOURCES_UNAVAILABLE',
        });
      });
    // `attempt` re-runs the effect for "Try again".
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    const next = cursor.current;
    const mine = generation.current;
    if (next === null) return;
    setState((current) =>
      current.phase === 'ready' ? { ...current, loadingMore: true, moreError: null } : current,
    );
    fetchRef
      .current(next)
      .then((response) => {
        if (mine !== generation.current) return;
        cursor.current = response.nextCursor;
        setState((current) => {
          if (current.phase !== 'ready') return current;
          const seen = new Set(current.items.map((item) => item.id));
          return {
            ...current,
            items: [...current.items, ...response.data.filter((item) => !seen.has(item.id))],
            meta: response.meta,
            hasMore: response.nextCursor !== null,
            loadingMore: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        setState((current) =>
          current.phase === 'ready'
            ? { ...current, loadingMore: false, moreError: listError(error) }
            : current,
        );
      });
  }, []);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { state, loadMore, retry };
}

function listError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'SOURCES_UNAVAILABLE') {
    return 'The anime catalog is temporarily unavailable. Try again in a moment.';
  }
  return describeError(error).message;
}
