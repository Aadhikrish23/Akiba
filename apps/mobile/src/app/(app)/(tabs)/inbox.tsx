import { describeError } from '@akiba/api-client';
import type { Notification } from '@akiba/shared';
import { Link } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import { useAuth } from '../../../auth/AuthContext';
import { Chips } from '../../../components/Chips';
import { Body, Button, Heading, Loading, Muted, Notice, TextLink } from '../../../components/ui';
import { formatMoment } from '../../../lib/format';
import { useInbox } from '../../../lib/inbox';
import { useTitleNames } from '../../../lib/useTitleNames';
import { useTheme } from '../../../theme/theme';

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

const newestFirst = (a: Notification, b: Notification): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/**
 * The Inbox (FR-NOTE-003): one entry per episode that aired for a title the reader is watching.
 * Mark one as read, mark everything as read, delete one. A change shows at once and is put back,
 * with a message, if the server refuses it.
 */
export default function InboxScreen() {
  const { client, profile } = useAuth();
  const { unread, refresh, setUnread } = useInbox();
  const theme = useTheme();
  const names = useTitleNames();
  const zone = profile?.timeZone ?? 'UTC';
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
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
    refresh(); // the badge and the list should agree when the screen opens
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

  const putBack = (item: Notification) => {
    setState((current) =>
      current.phase !== 'ready'
        ? current
        : current.items.some((have) => have.id === item.id)
          ? { ...current, items: current.items.map((have) => (have.id === item.id ? item : have)) }
          : { ...current, items: [...current.items, item].sort(newestFirst) },
    );
    refresh();
  };

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
    if (!quiet) {
      setAnnounce(`Marked episode ${item.episode.number} of ${names.name(item.title)} as read.`);
    }
    client.inbox.markRead(item.id).catch((error: unknown) => {
      setProblem(`${describeError(error).message} It was not marked as read.`);
      putBack(item);
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
    setAnnounce(`Deleted episode ${item.episode.number} of ${names.name(item.title)}.`);
    client.inbox.remove(item.id).catch((error: unknown) => {
      setProblem(`${describeError(error).message} It was not deleted.`);
      putBack(item);
    });
  };

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      style={{ backgroundColor: theme.colors.paper }}
      contentContainerStyle={{ padding: theme.space(4), gap: theme.space(4), flexGrow: 1 }}
      ItemSeparatorComponent={() => <View style={{ height: theme.space(2) }} />}
      onEndReachedThreshold={0.5}
      onEndReached={loadMore}
      ListHeaderComponent={
        <View style={{ gap: theme.space(4) }}>
          <Heading>Inbox</Heading>
          <Muted>
            New episodes of the titles you are watching appear here. Nothing is sent to your phone
            or your email.
          </Muted>
          <Chips
            label="Show"
            choices={[
              { value: 'all', label: 'Everything' },
              { value: 'unread', label: 'Unread only' },
            ]}
            value={filter}
            onChange={(value) => {
              setFilter(value === 'unread' ? 'unread' : 'all');
            }}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(4) }}>
            <Button
              label="Mark all as read"
              busy={busyAll}
              disabled={state.phase !== 'ready' || unread === 0}
              onPress={markAll}
            />
            <Muted>
              {unread === null ? '' : unread === 0 ? 'Nothing unread.' : `${unread} unread`}
            </Muted>
          </View>
          {announce !== '' && (
            <Text accessibilityLiveRegion="polite" style={{ height: 1, opacity: 0 }}>
              {announce}
            </Text>
          )}
          {problem !== null && <Notice tone="error">{problem}</Notice>}
        </View>
      }
      renderItem={({ item }) => {
        const name = names.name(item.title);
        const isNew = item.readAt === null;
        return (
          <View style={{ gap: theme.space(2), paddingVertical: theme.space(2) }}>
            <Link href={{ pathname: '/title/[id]', params: { id: item.title.id } }} asChild>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`${name}, episode ${item.episode.number} aired ${formatMoment(item.episode.airsAt, zone)}${isNew ? ', new' : ''}`}
                onPress={() => {
                  markRead(item, true);
                }}
                style={{ flexDirection: 'row', gap: theme.space(3), minHeight: 84 }}
              >
                <View
                  style={{
                    width: 56,
                    height: 84,
                    borderRadius: theme.radius,
                    borderWidth: theme.hairline,
                    borderColor: theme.colors.rule,
                    backgroundColor: theme.colors.raised,
                    overflow: 'hidden',
                  }}
                >
                  {item.title.coverUrl !== null && (
                    <Image
                      source={{ uri: item.title.coverUrl }}
                      accessible={false}
                      accessibilityIgnoresInvertColors
                      style={{ width: 56, height: 84 }}
                    />
                  )}
                </View>
                <View style={{ flex: 1, gap: theme.space(1), justifyContent: 'center' }}>
                  <Text
                    numberOfLines={2}
                    style={{
                      color: theme.colors.ink,
                      fontFamily: theme.fonts.serif,
                      fontWeight: '600',
                      fontSize: theme.type.lg,
                    }}
                  >
                    {name}
                  </Text>
                  <Text style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1 }}>
                    {isNew ? 'New · ' : ''}Episode {item.episode.number} aired{' '}
                    {formatMoment(item.episode.airsAt, zone)}
                  </Text>
                </View>
              </Pressable>
            </Link>
            <View style={{ flexDirection: 'row', gap: theme.space(5), flexWrap: 'wrap' }}>
              {isNew && (
                <Button
                  label="Mark as read"
                  variant="link"
                  accessibilityLabel={`Mark as read: episode ${item.episode.number} of ${name}`}
                  onPress={() => {
                    markRead(item);
                  }}
                />
              )}
              <Button
                label="Delete"
                variant="link"
                accessibilityLabel={`Delete: episode ${item.episode.number} of ${name}`}
                onPress={() => {
                  remove(item);
                }}
              />
            </View>
          </View>
        );
      }}
      ListEmptyComponent={
        state.phase === 'loading' ? (
          <Loading label="Loading your inbox" />
        ) : state.phase === 'error' ? (
          <View style={{ gap: theme.space(3) }}>
            <Notice tone="error">{state.message}</Notice>
            <Button
              label="Try again"
              onPress={() => {
                setAttempt((value) => value + 1);
              }}
            />
          </View>
        ) : (
          <View style={{ gap: theme.space(2) }}>
            <Body>
              {filter === 'unread'
                ? 'You are all caught up.'
                : 'Nothing yet. When a new episode of a title you are watching airs, it shows up here.'}
            </Body>
            {profile?.alertsEnabled === false && (
              <>
                <Body>Episode alerts are off for your account.</Body>
                <TextLink href="/settings">Turn them on in Settings</TextLink>
              </>
            )}
          </View>
        )
      }
      ListFooterComponent={
        state.phase === 'ready' && state.cursor !== null ? (
          <Button
            label={state.loadingMore ? 'Loading…' : 'Load more'}
            busy={state.loadingMore}
            onPress={loadMore}
          />
        ) : undefined
      }
    />
  );
}
