import { describeError } from '@akiba/api-client';
import type { LibraryEntry, LibraryListResponse } from '@akiba/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export type EntryListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly items: readonly LibraryEntry[];
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
      readonly moreError: string | null;
    };

/**
 * Load a library list: the first page when `key` changes, more on demand. A response for a request
 * that has been replaced is dropped (a slow old filter never overwrites a newer one).
 */
export function useEntryList(
  key: string,
  fetchPage: (cursor: string | undefined) => Promise<LibraryListResponse>,
) {
  const [state, setState] = useState<EntryListState>({ phase: 'loading' });
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
          hasMore: response.nextCursor !== null,
          loadingMore: false,
          moreError: null,
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        setState({ phase: 'error', message: describeError(error).message });
      });
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    const next = cursor.current;
    const mine = generation.current;
    if (next === null) return;
    cursor.current = null; // one page at a time
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
            hasMore: response.nextCursor !== null,
            loadingMore: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        cursor.current = next;
        setState((current) =>
          current.phase === 'ready'
            ? { ...current, loadingMore: false, moreError: describeError(error).message }
            : current,
        );
      });
  }, []);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { state, loadMore, retry };
}
