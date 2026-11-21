import { FlatList, View } from 'react-native';
import type { ReactElement } from 'react';
import type { ListState } from '../lib/useTitleList';
import { useTheme } from '../theme/theme';
import { Body, Button, Loading, Muted, Notice } from './ui';
import { TitleRow } from './TitleRow';

/**
 * A list of titles in all its states, as the root of a screen (a FlatList cannot sit inside a
 * ScrollView): `header` scrolls with the list. Loading, error with Try again, empty, results with a
 * "saved copy" label, and "Load more" both at the end of the list and as the end is reached.
 */
export function TitleResults({
  state,
  header,
  empty,
  onRetry,
  onLoadMore,
}: {
  state: ListState;
  header?: ReactElement;
  empty: string;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  const theme = useTheme();
  const items = state.phase === 'ready' ? state.items : [];
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <TitleRow title={item} />}
      ItemSeparatorComponent={() => <View style={{ height: theme.space(4) }} />}
      contentContainerStyle={{ padding: theme.space(4), gap: theme.space(4), flexGrow: 1 }}
      style={{ backgroundColor: theme.colors.paper }}
      keyboardShouldPersistTaps="handled"
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (state.phase === 'ready' && state.hasMore && !state.loadingMore) onLoadMore();
      }}
      ListHeaderComponent={
        <View style={{ gap: theme.space(4) }}>
          {header}
          {state.phase === 'ready' && state.meta.stale && (
            <Notice>
              Showing saved results: the anime catalog could not be reached just now. They may be
              out of date.
            </Notice>
          )}
        </View>
      }
      ListEmptyComponent={
        state.phase === 'loading' ? (
          <Loading label="Loading titles" />
        ) : state.phase === 'error' ? (
          <View style={{ gap: theme.space(3) }}>
            <Notice tone="error">{state.message}</Notice>
            <Button label="Try again" onPress={onRetry} />
          </View>
        ) : (
          <Body>{empty}</Body>
        )
      }
      ListFooterComponent={
        state.phase === 'ready' ? (
          <View style={{ gap: theme.space(3) }}>
            {state.moreError !== null && <Notice tone="error">{state.moreError}</Notice>}
            {state.hasMore && (
              <Button
                label={state.loadingMore ? 'Loading…' : 'Load more'}
                busy={state.loadingMore}
                onPress={onLoadMore}
              />
            )}
            {!state.hasMore && state.items.length > 0 && <Muted>That is everything.</Muted>}
          </View>
        ) : undefined
      }
    />
  );
}
