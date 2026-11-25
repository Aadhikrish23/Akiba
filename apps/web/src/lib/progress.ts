import { ApiError } from '@akiba/api-client';
import type { EntryStatus, LibraryEntryDetail } from '@akiba/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { describeError } from './errors';

export interface TrackedEntry {
  readonly id: string;
  readonly status: EntryStatus;
  readonly progress: number;
  readonly effectiveTotal: number | null;
  /** Episodes of a running show that have aired, while its total is unknown. */
  readonly episodesAired?: number | null;
}

/**
 * "+1 episode" the way doc 08 key flow 1 describes it: the count changes at once (optimistic), the
 * server confirms, and on failure the count goes back and says why. At the final episode the
 * server answers `suggestComplete` and the screen asks "Mark completed?" inline.
 */
export function useEntryProgress(
  entry: TrackedEntry,
  onChange?: (updated: LibraryEntryDetail) => void,
) {
  const { client } = useAuth();
  const [progress, setProgress] = useState(entry.progress);
  const [status, setStatus] = useState(entry.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState(false);

  // The list may reload with newer numbers (another device, another screen).
  useEffect(() => {
    setProgress(entry.progress);
    setStatus(entry.status);
  }, [entry.progress, entry.status]);

  // The ceiling: what has aired so far (a running show), never past the known total. A season of 20
  // with 8 aired stops at 8.
  const total = entry.effectiveTotal;
  const aired = entry.episodesAired ?? null;
  const limit = total !== null && aired !== null ? Math.min(total, aired) : (total ?? aired);
  const atEnd = limit !== null && progress >= limit;
  const canAdvance = status !== 'completed' && !atEnd;
  /** Up to date with what has aired, with episodes still to come (as opposed to the last episode). */
  const caughtUp = aired !== null && progress >= aired && (total === null || progress < total);

  // Taps can come faster than the server answers (a held Enter key, a double tap). Each one counts
  // at once; only the newest answer may set the number, so replies arriving out of order cannot
  // put it back, and a failed tap takes back only its own episode.
  const latest = useRef(0);
  const plusOne = useCallback(async () => {
    if (!canAdvance) return;
    const mine = ++latest.current;
    setError(null);
    setProgress((value) => value + 1);
    if (status === 'planned' || status === 'on_hold' || status === 'dropped') setStatus('watching');
    try {
      const result = await client.library.progress(entry.id, { delta: 1 });
      if (mine === latest.current) {
        setProgress(result.data.progress);
        setStatus(result.data.status);
        setSuggest(result.suggestComplete);
      }
      onChange?.(result.data);
    } catch (caught) {
      setProgress((value) => Math.max(0, value - 1));
      setError(
        caught instanceof ApiError && caught.code === 'PROGRESS_EXCEEDS_TOTAL'
          ? 'That is past the last episode.'
          : caught instanceof ApiError && caught.code === 'PROGRESS_EXCEEDS_AIRED'
            ? 'The next episode has not aired yet.'
            : describeError(caught).message,
      );
    }
  }, [canAdvance, status, client, entry.id, onChange]);

  /** Why `value` cannot be the count, or null when it can (the same rules the server applies). */
  const check = useCallback(
    (value: number): string | null => {
      if (!Number.isInteger(value) || value < 0) return 'Enter a whole number, 0 or more.';
      if (total !== null && value > total) {
        return `This show has ${total} episode${total === 1 ? '' : 's'}.`;
      }
      if (aired !== null && value > aired && value > progress) {
        return `Only ${aired} episode${aired === 1 ? ' has' : 's have'} aired so far.`;
      }
      return null;
    },
    [total, aired, progress],
  );

  /** Set the count outright: for someone who is already caught up and should not press +1 a thousand times. */
  const setTo = useCallback(
    async (value: number) => {
      if (value === progress || status === 'completed') return;
      const issue = check(value);
      if (issue !== null) {
        setError(issue);
        return;
      }
      const mine = ++latest.current;
      const before = progress;
      setError(null);
      setProgress(value);
      if (
        value > before &&
        (status === 'planned' || status === 'on_hold' || status === 'dropped')
      ) {
        setStatus('watching');
      }
      try {
        const result = await client.library.progress(entry.id, { set: value });
        if (mine === latest.current) {
          setProgress(result.data.progress);
          setStatus(result.data.status);
          setSuggest(result.suggestComplete);
        }
        onChange?.(result.data);
      } catch (caught) {
        if (mine === latest.current) {
          setProgress(before);
          setStatus(entry.status);
        }
        setError(
          caught instanceof ApiError && caught.code === 'PROGRESS_EXCEEDS_TOTAL'
            ? 'That is past the last episode.'
            : caught instanceof ApiError && caught.code === 'PROGRESS_EXCEEDS_AIRED'
              ? 'That episode has not aired yet.'
              : describeError(caught).message,
        );
      }
    },
    [progress, status, check, client, entry.id, entry.status, onChange],
  );

  const complete = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await client.library.update(entry.id, { status: 'completed' });
      setStatus(updated.status);
      setProgress(updated.progress);
      setSuggest(false);
      onChange?.(updated);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [client, entry.id, onChange]);

  return {
    progress,
    status,
    busy,
    error,
    suggest,
    canAdvance,
    caughtUp,
    total,
    aired,
    limit,
    check,
    setTo,
    plusOne,
    complete,
    dismissSuggestion: () => {
      setSuggest(false);
    },
  };
}
