import {
  ENTRY_STATUSES,
  type EntryStatus,
  type LibraryEntryDetail,
  type TitleDetail,
} from '@akiba/shared';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../lib/errors';
import { ENTRY_LABEL, displayTitle } from '../lib/titles';
import { PlusOne } from './EntryParts';
import { Button, Field, Notice, Select } from './ui';

/**
 * "On your shelf" on the title page: add it, then everything a user does with an entry (status,
 * +1, rating, favourite, review, episode count, rewatch, remove). One panel, one place.
 */
export function ShelfPanel({ title }: { title: TitleDetail }) {
  const { client } = useAuth();
  const [entry, setEntry] = useState<LibraryEntryDetail | null>(null);
  const [loading, setLoading] = useState(title.libraryEntryId !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addStatus, setAddStatus] = useState<EntryStatus>(
    title.status === 'releasing' ? 'watching' : 'planned',
  );
  const [review, setReview] = useState('');
  const [totalDraft, setTotalDraft] = useState('');
  const [editingTotal, setEditingTotal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const entryId = entry?.id ?? title.libraryEntryId;
  const name = displayTitle(title);

  const load = useCallback(
    (id: string) => {
      setLoading(true);
      client.library
        .get(id)
        .then((value) => {
          setEntry(value);
          setReview(value.review ?? '');
        })
        .catch((caught: unknown) => {
          setError(describeError(caught).message);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [client],
  );
  useEffect(() => {
    if (title.libraryEntryId !== null) load(title.libraryEntryId);
  }, [title.libraryEntryId, load]);

  const run = async (action: () => Promise<LibraryEntryDetail | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setEntry(next);
      if (next !== null) setReview(next.review ?? '');
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <p role="status" aria-busy="true" className="text-mute">
        Loading your shelf…
      </p>
    );

  if (entryId === null || entry === null) {
    return (
      <section
        aria-labelledby="shelf-heading"
        className="border-rule bg-raised grid gap-3 rounded-lg border p-5"
      >
        <h2 id="shelf-heading" className="h-sub">
          Add to your library
        </h2>
        {error !== null && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Status"
            anyLabel=""
            value={addStatus}
            options={ENTRY_STATUSES.map((value) => ({ value, label: ENTRY_LABEL[value] }))}
            onChange={(event) => {
              setAddStatus(event.target.value as EntryStatus);
            }}
          />
          <Button
            variant="primary"
            busy={busy}
            onClick={() => void run(() => client.library.add(title.id, addStatus))}
          >
            Add to library
          </Button>
        </div>
      </section>
    );
  }

  const change = (changes: Parameters<typeof client.library.update>[1]) =>
    run(() => client.library.update(entry.id, changes));

  return (
    <section
      aria-labelledby="shelf-heading"
      className="border-rule bg-raised grid gap-5 rounded-lg border p-5"
    >
      <h2 id="shelf-heading" className="h-sub">
        On your shelf
      </h2>
      {error !== null && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-wrap items-end gap-4">
        <Select
          label="Status"
          anyLabel=""
          value={entry.status}
          options={ENTRY_STATUSES.map((value) => ({ value, label: ENTRY_LABEL[value] }))}
          onChange={(event) => void change({ status: event.target.value as EntryStatus })}
        />
        <Select
          label="Your rating"
          anyLabel="Not rated"
          value={entry.rating === null ? '' : String(entry.rating)}
          options={Array.from({ length: 10 }, (_, index) => ({
            value: String(index + 1),
            label: `${index + 1} / 10`,
          }))}
          onChange={(event) =>
            void change({ rating: event.target.value === '' ? null : Number(event.target.value) })
          }
        />
        <label className="flex h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={entry.isFavorite}
            onChange={(event) => void change({ isFavorite: event.target.checked })}
          />
          Favorite
        </label>
      </div>

      {entry.status === 'watching' && (
        <Select
          label="Episode alerts for this title"
          anyLabel="Follow my account setting"
          value={entry.alertsEnabled === null ? '' : entry.alertsEnabled ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(event) =>
            void change({
              alertsEnabled: event.target.value === '' ? null : event.target.value === 'on',
            })
          }
        />
      )}

      {entry.status !== 'completed' ? (
        <PlusOne entry={entry} name={name} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Completed {entry.progress} of {entry.effectiveTotal ?? '?'} episodes.
          </span>
          <Button busy={busy} onClick={() => void run(() => client.library.startRun(entry.id))}>
            Rewatch
          </Button>
        </div>
      )}

      <div className="grid gap-2 text-sm">
        {entry.totalOverridden && (
          <p>
            <span className="border-ink rounded-full border px-2.5 py-0.5 font-medium">Edited</span>{' '}
            The episode count is your own: {entry.effectiveTotal}.{' '}
            <Button
              variant="link"
              onClick={() => void run(() => client.library.clearEpisodesTotal(entry.id))}
            >
              Reset to {title.episodesTotal ?? 'unknown'}
            </Button>
          </p>
        )}
        {!editingTotal ? (
          <p>
            <Button
              variant="link"
              onClick={() => {
                setTotalDraft(String(entry.effectiveTotal ?? ''));
                setEditingTotal(true);
              }}
            >
              Episode count looks wrong?
            </Button>
          </p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => client.library.setEpisodesTotal(entry.id, Number(totalDraft))).then(
                () => {
                  setEditingTotal(false);
                },
              );
            }}
          >
            <Field
              label="Number of episodes"
              type="number"
              min={1}
              value={totalDraft}
              onChange={(event) => {
                setTotalDraft(event.target.value);
              }}
            />
            <Button type="submit" busy={busy}>
              Save
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEditingTotal(false);
              }}
            >
              Cancel
            </Button>
          </form>
        )}
      </div>

      <form
        className="grid max-w-prose gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void change({ review: review.trim() === '' ? null : review });
        }}
      >
        <label htmlFor="review" className="text-sm font-medium">
          Your review (private)
        </label>
        <textarea
          id="review"
          rows={4}
          value={review}
          onChange={(event) => {
            setReview(event.target.value);
          }}
          className="border-rule bg-raised text-ink w-full rounded-sm border p-3 text-base"
        />
        <div>
          <Button type="submit" busy={busy}>
            Save review
          </Button>
        </div>
      </form>

      {entry.runs.length > 0 && (
        <div>
          <h3 className="text-mute mb-2 text-sm font-medium tracking-wide uppercase">Viewings</h3>
          <ol className="grid list-none gap-1 p-0 text-sm" aria-label="Viewings">
            {entry.runs.map((viewing) => (
              <li key={viewing.id}>
                Run {viewing.runNumber}: started {viewing.startedAt.slice(0, 10)}
                {viewing.finishedAt === null
                  ? ', in progress'
                  : `, finished ${viewing.finishedAt.slice(0, 10)}`}
                {viewing.rating !== null && `, rated ${viewing.rating} / 10`}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div>
        {!confirmRemove ? (
          <Button
            variant="link"
            onClick={() => {
              setConfirmRemove(true);
            }}
          >
            Remove from library
          </Button>
        ) : (
          <p role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            Remove this title? Your viewings are kept.
            <Button
              variant="link"
              onClick={() =>
                void run(async () => {
                  await client.library.remove(entry.id);
                  setConfirmRemove(false);
                  return null;
                })
              }
            >
              Yes, remove it
            </Button>
            <Button
              variant="link"
              onClick={() => {
                setConfirmRemove(false);
              }}
            >
              Keep it
            </Button>
          </p>
        )}
      </div>
    </section>
  );
}
