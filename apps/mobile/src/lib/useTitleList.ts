import { ApiError, describeError } from '@akiba/api-client';
import type { CatalogMeta, TitleCard, TitleListResponse } from '@akiba/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly items: readonly TitleCard[];
      readonly meta: CatalogMeta;
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
      readonly moreError: string | null;
    };

function listError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'SOURCES_UNAVAILABLE') {
    return 'The anime catalog is temporarily unavailable. Try again in a moment.';
  }
  return describeError(error).message;
}

/**
 * Load the first page of a list when `key` changes (a new search, a new filter), and further pages
 * on demand. A response for a request that has since been replaced is dropped, so a slow old search
 * can never overwrite a newer one. (The web app has the same hook; the two are kept in step by
 * their tests.)
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
        setState({ phase: 'error', message: listError(error) });
      });
    // `attempt` re-runs the effect for "Try again".
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    const next = cursor.current;
    const mine = generation.current;
    if (next === null) return;
    cursor.current = null; // one page at a time: a second call before this one returns does nothing
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
        cursor.current = next; // the same page can be asked for again
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
