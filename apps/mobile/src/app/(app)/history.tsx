import { describeError } from '@akiba/api-client';
import { EVENT_TYPES, describeEvent, type EventType, type HistoryItem } from '@akiba/shared';
import { Link, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthContext';
import { Chips, type Choice } from '../../components/Chips';
import { Body, Button, Heading, Loading, Muted, Notice, TextLink } from '../../components/ui';
import { formatDay, formatMoment } from '../../lib/format';
import { useTitleNames } from '../../lib/useTitleNames';
import { useTheme } from '../../theme/theme';

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

const KINDS: Choice<EventType>[] = [
  { value: '', label: 'Everything' },
  ...EVENT_TYPES.map((value) => ({ value, label: TYPE_LABEL[value] })),
];

/**
 * The history timeline (FR-REM-003): everything the reader did, newest first, one sentence each,
 * filterable by kind, with the day and the time in the reader's own time zone.
 */
export default function HistoryScreen() {
  const { client, profile } = useAuth();
  const theme = useTheme();
  const names = useTitleNames();
  const zone = profile?.timeZone ?? 'UTC';
  const [type, setType] = useState<EventType | ''>('');
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const load = useCallback(
    (cursor?: string) => {
      const mine = generation.current;
      return client.history
        .list({
          limit: 30,
          ...(type === '' ? {} : { type: [type] }),
          ...(cursor === undefined ? {} : { cursor }),
        })
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
  }, [load, attempt]);

  return (
    <>
      <Stack.Screen options={{ title: 'History' }} />
      <FlatList
        data={items ?? []}
        keyExtractor={(item) => item.id}
        style={{ backgroundColor: theme.colors.paper }}
        contentContainerStyle={{ padding: theme.space(4), gap: theme.space(4), flexGrow: 1 }}
        ListHeaderComponent={
          <View style={{ gap: theme.space(4) }}>
            <Heading>History</Heading>
            <Chips label="Show" choices={KINDS} value={type} onChange={setType} />
          </View>
        }
        renderItem={({ item, index }) => {
          const previous = index === 0 ? undefined : items?.[index - 1];
          const day = formatDay(item.occurredAt, zone);
          const showDay = previous === undefined || formatDay(previous.occurredAt, zone) !== day;
          return (
            <View style={{ gap: theme.space(2) }}>
              {showDay && (
                <Text
                  accessibilityRole="header"
                  style={{
                    color: theme.colors.mute,
                    fontSize: theme.type.sm * 1.1,
                    fontWeight: '600',
                  }}
                >
                  {day}
                </Text>
              )}
              <Link href={{ pathname: '/title/[id]', params: { id: item.title.id } }} asChild>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`${names.name(item.title)}: ${describeEvent(item)}, ${formatMoment(item.occurredAt, zone)}`}
                  style={{ minHeight: 48, justifyContent: 'center', gap: 2 }}
                >
                  <Text
                    style={{
                      color: theme.colors.ink,
                      fontFamily: theme.fonts.serif,
                      fontWeight: '600',
                      fontSize: theme.type.base * 1.07,
                    }}
                  >
                    {names.name(item.title)}
                  </Text>
                  <Text style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1 }}>
                    {describeEvent(item)}
                  </Text>
                  <Text style={{ color: theme.colors.mute, fontSize: theme.type.sm * 1.1 }}>
                    {formatMoment(item.occurredAt, zone)}
                  </Text>
                </Pressable>
              </Link>
            </View>
          );
        }}
        ListEmptyComponent={
          error !== null ? (
            <View style={{ gap: theme.space(3) }}>
              <Notice tone="error">{error}</Notice>
              <Button
                label="Try again"
                onPress={() => {
                  setAttempt((value) => value + 1);
                }}
              />
            </View>
          ) : items === null ? (
            <Loading label="Loading your history" />
          ) : (
            <View style={{ gap: theme.space(2) }}>
              <Body>
                {type === ''
                  ? 'Nothing has happened yet. Add a title and watch an episode.'
                  : 'Nothing of that kind has happened yet.'}
              </Body>
              {type === '' && <TextLink href="/discover">Find something to watch</TextLink>}
            </View>
          )
        }
        ListFooterComponent={
          next === null ? (
            items !== null && items.length > 0 ? (
              <Muted>That is everything.</Muted>
            ) : undefined
          ) : (
            <Button
              label={loadingMore ? 'Loading…' : 'Load more'}
              busy={loadingMore}
              onPress={() => {
                setLoadingMore(true);
                load(next)
                  .catch((caught: unknown) => {
                    setError(describeError(caught).message);
                  })
                  .finally(() => {
                    setLoadingMore(false);
                  });
              }}
            />
          )
        }
      />
    </>
  );
}
