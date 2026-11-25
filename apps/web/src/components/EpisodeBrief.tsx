import type { LibraryEntry } from '@akiba/shared';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useRemote } from '../lib/remote';

type Tab = 'prev' | 'next' | 'note';

/** What one tab shows, loaded when it is opened. */
type Loaded =
  | { readonly kind: 'episode'; readonly name: string | null; readonly synopsis: string | null }
  | { readonly kind: 'note'; readonly text: string | null };

/**
 * The text on the big ticket: "Previously" (the synopsis of the episode you just watched),
 * "Up next" (the name of the one you are about to watch, with its synopsis held back until you ask,
 * so nothing is spoiled) and "My note". Episodes up to the one you are on are shown; later ones
 * never are.
 */
export function EpisodeBrief({
  entry,
  progress,
  canAdvance,
}: {
  entry: LibraryEntry;
  progress: number;
  canAdvance: boolean;
}) {
  const { client } = useAuth();
  const hasPrev = progress >= 1;
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab =
    chosen === 'next' && !canAdvance
      ? 'prev'
      : (chosen ?? (hasPrev ? 'prev' : canAdvance ? 'next' : 'note'));
  const number = tab === 'prev' ? progress : progress + 1;

  const { state } = useRemote<Loaded>(`brief:${entry.id}:${tab}:${number}`, async () => {
    if (tab === 'note') {
      const detail = await client.library.get(entry.id);
      return { kind: 'note', text: detail.notes };
    }
    const info = await client.titles.episode(entry.title.id, number);
    return { kind: 'episode', name: info.data.name, synopsis: info.data.synopsis };
  });

  // Holding the teaser back again whenever the episode changes (+1 moves on to the next one).
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setShown(null);
  }, [entry.id, number]);

  const tabs: { id: Tab; label: string }[] = [
    ...(hasPrev ? [{ id: 'prev' as const, label: `Previously · Ep ${progress}` }] : []),
    ...(canAdvance ? [{ id: 'next' as const, label: `Up next · Ep ${progress + 1}` }] : []),
    { id: 'note', label: 'My note' },
  ];

  const teaserKey = `${entry.id}:${number}`;
  return (
    <div className="ticket__brief">
      <div className="brief__tabs" role="group" aria-label="About this show">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => {
              setChosen(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="brief__body" aria-live="polite">
        {state.phase === 'loading' && <p>Loading…</p>}
        {(state.phase === 'error' || state.phase === 'missing') && (
          <p>This could not be loaded just now.</p>
        )}
        {state.phase === 'ready' && state.value.kind === 'note' && (
          <p>
            {state.value.text === null || state.value.text === ''
              ? 'No note yet.'
              : state.value.text}
          </p>
        )}
        {state.phase === 'ready' && state.value.kind === 'episode' && (
          <>
            {state.value.name !== null && <p className="brief__name">{state.value.name}</p>}
            {state.value.synopsis === null ? (
              state.value.name === null && <p>No synopsis for episode {number} yet.</p>
            ) : tab === 'next' && shown !== teaserKey ? (
              <button
                type="button"
                className="brief__reveal"
                onClick={() => {
                  setShown(teaserKey);
                }}
              >
                Show the teaser
              </button>
            ) : (
              <p className="brief__synopsis">{state.value.synopsis}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
