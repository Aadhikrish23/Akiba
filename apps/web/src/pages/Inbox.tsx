import type { Notification } from '@akiba/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Notice, Select } from '../components/ui';
import { describeError } from '../lib/errors';
import { useInbox } from '../lib/inbox';
import { usePageTitle } from '../lib/page';
import { displayTitle } from '../lib/titles';

type State =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly items: readonly Notification[];
      readonly cursor: string | null;
      readonly loadingMore: boolean;
    };

type Filter = 'all' | 'unread';

/** "Fri, 20 Nov, 23:00 JST": the airing time in the reader's own time zone (doc 08, FR-NOTE). */
export function formatAirTime(iso: string, zone: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: zone,
      timeZoneName: 'short',
    });
  } catch {
    return new Date(iso).toISOString();
  }
}

/**
 * The Inbox (FR-NOTE-003): one line per episode that aired for a title the reader is watching.
 * Mark one as read, mark everything as read, delete one. Changes show at once and are put back,
 * with a message, if the server refuses them.
 */
export function InboxPage() {
  usePageTitle('Inbox');
  const { client, profile } = useAuth();
  const { unread, refresh, setUnread } = useInbox();
  const zone = profile?.timeZone ?? 'UTC';
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [announce, setAnnounce] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setState({ phase: 'loading' });
    client.inbox
      .list(filter === 'unread' ? { unread: true } : {})
      .then((page) => {
        if (mine === generation.current) {
          setState({
            phase: 'ready',
            items: page.data,
            cursor: page.nextCursor,
            loadingMore: false,
          });
        }
      })
      .catch((error: unknown) => {
        if (mine === generation.current) {
          setState({ phase: 'error', message: describeError(error).message });
        }
      });
    refresh(); // the badge and the list should agree when the page opens
  }, [client, filter, attempt, refresh]);

  const loadMore = useCallback(() => {
    if (state.phase !== 'ready' || state.cursor === null || state.loadingMore) return;
    const { cursor } = state;
    setState({ ...state, loadingMore: true });
    client.inbox
      .list({ ...(filter === 'unread' ? { unread: true } : {}), cursor })
      .then((page) => {
        setState((current) =>
          current.phase === 'ready'
            ? {
                phase: 'ready',
                items: [
                  ...current.items,
                  ...page.data.filter((item) => !current.items.some((have) => have.id === item.id)),
                ],
                cursor: page.nextCursor,
                loadingMore: false,
              }
            : current,
        );
      })
      .catch((error: unknown) => {
        setProblem(describeError(error).message);
        setState((current) =>
          current.phase === 'ready' ? { ...current, loadingMore: false } : current,
        );
      });
  }, [client, filter, state]);

  const items = state.phase === 'ready' ? state.items : [];
  const unreadHere = items.filter((item) => item.readAt === null).length;

  const markRead = (item: Notification, quiet = false) => {
    if (item.readAt !== null) return;
    setProblem(null);
    const stamp = new Date().toISOString();
    setState((current) =>
      current.phase === 'ready'
        ? {
            ...current,
            items:
              filter === 'unread' && !quiet
                ? current.items.filter((have) => have.id !== item.id)
                : current.items.map((have) =>
                    have.id === item.id ? { ...have, readAt: stamp } : have,
                  ),
          }
        : current,
    );
    setUnread((count) => (count === null ? count : Math.max(0, count - 1)));
    if (!quiet)
      setAnnounce(`Marked episode ${item.episode.number} of ${displayTitle(item.title)} as read.`);
    client.inbox.markRead(item.id).catch((error: unknown) => {
      // Put it back, and say so.
      setProblem(`${describeError(error).message} It was not marked as read.`);
      setState((current) =>
        current.phase === 'ready' && !current.items.some((have) => have.id === item.id)
          ? { ...current, items: [...current.items, item].sort(newestFirst) }
          : current.phase === 'ready'
            ? {
                ...current,
                items: current.items.map((have) => (have.id === item.id ? item : have)),
              }
            : current,
      );
      refresh();
    });
  };

  const markAll = () => {
    setBusyAll(true);
    setProblem(null);
    client.inbox
      .markAllRead()
      .then((updated) => {
        const stamp = new Date().toISOString();
        setState((current) =>
          current.phase === 'ready'
            ? {
                ...current,
                items:
                  filter === 'unread'
                    ? []
                    : current.items.map((item) =>
                        item.readAt === null ? { ...item, readAt: stamp } : item,
                      ),
              }
            : current,
        );
        setUnread(0);
        setAnnounce(updated === 0 ? 'Nothing was unread.' : `Marked ${updated} as read.`);
      })
      .catch((error: unknown) => {
        setProblem(`${describeError(error).message} Nothing was marked as read.`);
      })
      .finally(() => {
        setBusyAll(false);
      });
  };

  const remove = (item: Notification) => {
    setProblem(null);
    setState((current) =>
      current.phase === 'ready'
        ? { ...current, items: current.items.filter((have) => have.id !== item.id) }
        : current,
    );
    if (item.readAt === null)
      setUnread((count) => (count === null ? count : Math.max(0, count - 1)));
    setAnnounce(`Deleted episode ${item.episode.number} of ${displayTitle(item.title)}.`);
    client.inbox.remove(item.id).catch((error: unknown) => {
      setProblem(`${describeError(error).message} It was not deleted.`);
      setState((current) =>
        current.phase === 'ready'
          ? { ...current, items: [...current.items, item].sort(newestFirst) }
          : current,
      );
      refresh();
    });
  };

  return (
    <div className="grid max-w-3xl gap-6">
      <header className="grid gap-3">
        <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">Inbox</h1>
        <p className="text-mute">
          New episodes of the titles you are watching appear here. Nothing is sent to your phone or
          your email.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-4">
        <Select
          label="Show"
          anyLabel=""
          value={filter}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'unread', label: 'Unread only' },
          ]}
          onChange={(event) => {
            setFilter(event.target.value === 'unread' ? 'unread' : 'all');
          }}
        />
        <Button busy={busyAll} onClick={markAll} disabled={state.phase !== 'ready' || unread === 0}>
          Mark all as read
        </Button>
        <p role="status" className="text-mute pb-2.5 text-sm">
          {unread === null ? '' : unread === 0 ? 'Nothing unread.' : `${unread} unread`}
        </p>
      </div>

      <p role="status" className="sr-only">
        {announce}
      </p>
      {problem !== null && <Notice tone="error">{problem}</Notice>}

      {state.phase === 'loading' && (
        <div aria-busy="true" role="status" aria-label="Loading your inbox" className="grid gap-4">
          {[0, 1, 2].map((index) => (
            <div key={index} className="bg-rule/50 h-16 rounded-sm" aria-hidden="true" />
          ))}
        </div>
      )}
      {state.phase === 'error' && (
        <div className="grid max-w-prose gap-4">
          <Notice tone="error">{state.message}</Notice>
          <div>
            <Button
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      )}
      {state.phase === 'ready' && items.length === 0 && (
        <div className="text-mute grid max-w-prose gap-2">
          {filter === 'unread' ? (
            <p>You are all caught up.</p>
          ) : (
            <p>
              Nothing yet. When a new episode of a title you are <em>Watching</em> airs, it shows up
              here.
            </p>
          )}
          {profile?.alertsEnabled === false && (
            <p>
              Episode alerts are off for your account.{' '}
              <Link to="/settings" className="underline underline-offset-4">
                Turn them on in Settings
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {state.phase === 'ready' && items.length > 0 && (
        <>
          <p role="status" className="sr-only">
            {items.length} {items.length === 1 ? 'notification' : 'notifications'} shown,{' '}
            {unreadHere} unread
          </p>
          <ul aria-label="Notifications" className="grid list-none gap-0 p-0">
            {items.map((item) => {
              const name = displayTitle(item.title);
              const isNew = item.readAt === null;
              return (
                <li key={item.id} className="border-rule border-t py-4 last:border-b">
                  <article className="grid grid-cols-[48px_1fr] gap-4">
                    <div className="bg-raised border-rule aspect-[2/3] overflow-hidden rounded-sm border">
                      {item.title.coverUrl !== null && (
                        <img
                          src={item.title.coverUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover"
                        />
                      )}
                    </div>
                    <div className="grid content-start gap-1.5">
                      <h2 className="font-serif text-lg leading-snug font-semibold">
                        <Link
                          to={`/title/${item.title.id}`}
                          className="underline-offset-4 hover:underline"
                          onClick={() => {
                            markRead(item, true);
                          }}
                        >
                          {name}
                        </Link>
                      </h2>
                      <p>
                        {isNew && (
                          <span className="border-ink mr-2 rounded-sm border px-1.5 py-0.5 text-xs font-medium">
                            New
                          </span>
                        )}
                        Episode {item.episode.number} aired{' '}
                        <time dateTime={item.episode.airsAt}>
                          {formatAirTime(item.episode.airsAt, zone)}
                        </time>
                      </p>
                      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                        {isNew && (
                          <Button
                            variant="link"
                            aria-label={`Mark as read: episode ${item.episode.number} of ${name}`}
                            onClick={() => {
                              markRead(item);
                            }}
                          >
                            Mark as read
                          </Button>
                        )}
                        <Button
                          variant="link"
                          aria-label={`Delete: episode ${item.episode.number} of ${name}`}
                          onClick={() => {
                            remove(item);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
          {state.cursor !== null && (
            <div>
              <Button onClick={loadMore} busy={state.loadingMore}>
                {state.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const newestFirst = (a: Notification, b: Notification): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
