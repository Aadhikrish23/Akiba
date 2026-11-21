import { ApiError } from '@akiba/api-client';
import { useEffect, useRef, useState } from 'react';
import { describeError } from './errors';

export type Remote<T> =
  | { readonly phase: 'loading' }
  /** The server says it does not exist (or is hidden from this user). */
  | { readonly phase: 'missing' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly value: T };

/**
 * Load one thing when `key` changes. A slow answer for an earlier `key` is dropped, so navigating
 * between two pages can never show the first one's data on the second. `retry` loads it again.
 */
export function useRemote<T>(
  key: string,
  load: () => Promise<T>,
): { state: Remote<T>; retry: () => void } {
  const [state, setState] = useState<Remote<T>>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setState({ phase: 'loading' });
    loadRef
      .current()
      .then((value) => {
        if (live) setState({ phase: 'ready', value });
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setState({ phase: 'missing' });
        else setState({ phase: 'error', message: describeError(error).message });
      });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  return {
    state,
    retry: () => {
      setAttempt((value) => value + 1);
    },
  };
}
