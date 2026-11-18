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

  const atEnd = entry.effectiveTotal !== null && progress >= entry.effectiveTotal;
  const canAdvance = status !== 'completed' && !atEnd;

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
          : describeError(caught).message,
      );
    }
  }, [canAdvance, status, client, entry.id, onChange]);

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
    plusOne,
    complete,
    dismissSuggestion: () => {
      setSuggest(false);
    },
  };
}
