import { EVENT_TYPES, describeEvent, type EventType, type HistoryItem } from '@akiba/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Notice, Select } from '../components/ui';
import { describeError } from '../lib/errors';
import { usePageTitle } from '../lib/page';
import { displayTitle } from '../lib/titles';

const TYPE_LABEL: Record<EventType, string> = {
  entry_added: 'Added to library',
  status_changed: 'Status changes',
  progress_changed: 'Episodes watched',
  run_started: 'Viewings started',
  run_completed: 'Viewings finished',
  rated: 'Ratings',
  reviewed: 'Reviews',
  favorited: 'Favorites added',
  unfavorited: 'Favorites removed',
  total_overridden: 'Episode counts edited',
  total_override_cleared: 'Episode counts reset',
  entry_removed: 'Removed from library',
};

/** The history timeline (FR-REM-003): newest first, grouped by day, filterable by kind. */
export function HistoryPage() {
  usePageTitle('History');
  const { client, profile } = useAuth();
  const [type, setType] = useState<EventType | ''>('');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    (cursor?: string) => {
      const mine = generation.current;
      return client.history
        .list({ type: type === '' ? undefined : ([type] as never), limit: 30, cursor })
        .then((response) => {
          if (mine !== generation.current) return;
          setItems((current) =>
            cursor === undefined || current === null
              ? response.data
              : [...current, ...response.data],
          );
          setNext(response.nextCursor);
        });
    },
    [client, type],
  );

  useEffect(() => {
    generation.current += 1;
    setItems(null);
    setError(null);
    load().catch((caught: unknown) => {
      setError(describeError(caught).message);
    });
  }, [load]);

  const zone = profile?.timeZone ?? 'UTC';
  const day = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, { dateStyle: 'full', timeZone: zone });
  const time = (iso: string): string =>
    new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'short', timeZone: zone });

  const groups: { day: string; entries: HistoryItem[] }[] = [];
  for (const item of items ?? []) {
    const label = day(item.occurredAt);
    const last = groups.at(-1);
    if (last?.day === label) last.entries.push(item);
    else groups.push({ day: label, entries: [item] });
  }

  return (
    <div className="grid gap-8">
      <h1 className="h-title">History</h1>
      <div className="max-w-xs">
        <Select
          label="Show"
          anyLabel="Everything"
          value={type}
          options={EVENT_TYPES.map((value) => ({ value, label: TYPE_LABEL[value] }))}
          onChange={(event) => {
            setType(event.target.value as EventType | '');
          }}
        />
      </div>
      {error !== null && <Notice tone="error">{error}</Notice>}
      {items === null && error === null && (
        <p role="status" aria-busy="true" className="text-mute">
          Loading history…
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="text-mute max-w-prose">
          Nothing here yet. Add a title and log an episode, and it will appear.{' '}
          <Link to="/discover" className="underline underline-offset-4">
            Discover
          </Link>
        </p>
      )}
      {groups.map((group) => (
        <section key={group.day} aria-label={group.day} className="grid gap-2">
          <h2 className="text-mute text-sm font-medium tracking-wide uppercase">{group.day}</h2>
          <ol className="grid list-none gap-0 p-0">
            {group.entries.map((item) => (
              <li
                key={item.id}
                className="border-rule grid grid-cols-[4.5rem_1fr] gap-3 border-b py-3"
              >
                <time dateTime={item.occurredAt} className="text-mute text-sm tabular-nums">
                  {time(item.occurredAt)}
                </time>
                <p>
                  <Link
                    to={`/title/${item.title.id}`}
                    className="h-item underline-offset-4 hover:underline"
                  >
                    {displayTitle(item.title)}
                  </Link>
                  <span className="block text-sm">{describeEvent(item)}</span>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {next !== null && (
        <div>
          <Button
            busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              load(next)
                .catch((caught: unknown) => {
                  setError(describeError(caught).message);
                })
                .finally(() => {
                  setLoadingMore(false);
                });
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
