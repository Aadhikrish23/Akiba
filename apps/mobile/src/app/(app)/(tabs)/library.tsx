import {
  ENTRY_LABEL,
  ENTRY_STATUSES,
  LIBRARY_SORTS,
  type LibraryCounts,
  type LibrarySort,
} from '@akiba/shared';
import { useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useAuth } from '../../../auth/AuthContext';
import { Chips, type Choice } from '../../../components/Chips';
import { EntryPoster, EntryRow, GRID } from '../../../components/EntryViews';
import {
  Body,
  Button,
  Field,
  Heading,
  Loading,
  Muted,
  Notice,
  TextLink,
} from '../../../components/ui';
import { useEntryList } from '../../../lib/useEntryList';
import { useTheme } from '../../../theme/theme';

type Tab = 'all' | 'favorites' | (typeof ENTRY_STATUSES)[number];
type View_ = 'grid' | 'list';

const SORT_LABEL: Record<LibrarySort, string> = {
  updated: 'Recently updated',
  title: 'Title',
  rating: 'Rating',
  progress: 'Progress',
  start_date: 'Newest',
};

const TAB_LABEL = (tab: Tab): string =>
  tab === 'all' ? 'All' : tab === 'favorites' ? 'Favorites' : ENTRY_LABEL[tab];

/**
 * The library (FR-LIB-003…005): sections with counts, search, sort and two layouts, a poster grid
 * or a list with +1 on every row. The layout is remembered on the account, so the web app and the
 * phone agree.
 */
export default function LibraryScreen() {
  const { client, profile, updateProfile } = useAuth();
  const theme = useTheme();
  const [tab, setTab] = useState<Tab>('all');
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<LibrarySort>('updated');
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const [view, setView] = useState<View_>(profile?.libraryView ?? 'grid');
  const [viewError, setViewError] = useState<string | null>(null);

  // The account's layout arrives with the profile (a moment after log-in).
  const accountView = profile?.libraryView;
  useEffect(() => {
    if (accountView !== undefined) setView(accountView);
  }, [accountView]);

  useEffect(() => {
    let live = true;
    client.library
      .counts()
      .then((value) => {
        if (live) setCounts(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);

  const key = JSON.stringify({ tab, q, sort });
  const { state, loadMore, retry } = useEntryList(key, (cursor) => {
    const query = {
      sort,
      limit: 24,
      ...(q === '' ? {} : { q }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    return tab === 'favorites'
      ? client.library.favorites(query)
      : client.library.list({ ...query, ...(tab === 'all' ? {} : { status: tab }) });
  });

  const count = (value: Tab): number | null =>
    counts === null
      ? null
      : value === 'all'
        ? ENTRY_STATUSES.reduce((sum, status) => sum + counts[status], 0)
        : value === 'favorites'
          ? counts.favorites
          : counts[value];
  const tabs: Choice<Tab>[] = (['all', ...ENTRY_STATUSES, 'favorites'] as const).map((value) => ({
    value,
    label: count(value) === null ? TAB_LABEL(value) : `${TAB_LABEL(value)} ${count(value)}`,
  }));

  const chooseView = (next: View_ | '') => {
    if (next === '') return;
    setView(next); // at once; put back if the account cannot be changed
    setViewError(null);
    updateProfile({ libraryView: next }).catch(() => {
      setView(profile?.libraryView ?? 'grid');
      setViewError('The layout could not be saved to your account.');
    });
  };

  const submit = () => {
    setQ(draft.trim());
  };

  const header = (
    <View style={{ gap: theme.space(4) }}>
      <Chips
        label="Library sections"
        choices={tabs}
        value={tab}
        onChange={(v) => setTab(v === '' ? 'all' : v)}
      />
      <Field
        label="Search your library"
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={submit}
      />
      <View style={{ flexDirection: 'row', gap: theme.space(3), flexWrap: 'wrap' }}>
        <Button label="Search" onPress={submit} />
        {q !== '' && (
          <Button
            label="Clear search"
            onPress={() => {
              setDraft('');
              setQ('');
            }}
          />
        )}
      </View>
      <Chips
        label="Sort by"
        choices={LIBRARY_SORTS.map((value) => ({ value, label: SORT_LABEL[value] }))}
        value={sort}
        onChange={(v) => setSort(v === '' ? 'updated' : v)}
      />
      <Chips
        label="Layout"
        choices={[
          { value: 'grid', label: 'Grid' },
          { value: 'list', label: 'List' },
        ]}
        value={view}
        onChange={chooseView}
      />
      {viewError !== null && <Notice tone="error">{viewError}</Notice>}
      <Heading level={2}>{TAB_LABEL(tab)}</Heading>
    </View>
  );

  const items = state.phase === 'ready' ? state.items : [];
  const empty =
    tab === 'all' && q === '' ? (
      <View style={{ gap: theme.space(2) }}>
        <Body>Your library is empty. Add what you are watching, or what you want to.</Body>
        <TextLink href="/discover">Find something to watch</TextLink>
      </View>
    ) : (
      <Body>
        {q === ''
          ? 'Nothing here yet.'
          : `Nothing in your library matches “${q}”. Remove a filter to see more.`}
      </Body>
    );

  return (
    <FlatList
      key={view} // the number of columns cannot change on a live list
      data={items}
      numColumns={view === 'grid' ? 2 : 1}
      keyExtractor={(entry) => entry.id}
      renderItem={({ item }) =>
        view === 'grid' ? <EntryPoster entry={item} /> : <EntryRow entry={item} />
      }
      columnWrapperStyle={view === 'grid' ? { gap: GRID.gap } : undefined}
      ItemSeparatorComponent={() => <View style={{ height: theme.space(5) }} />}
      contentContainerStyle={{ padding: GRID.padding, gap: theme.space(4), flexGrow: 1 }}
      style={{ backgroundColor: theme.colors.paper }}
      keyboardShouldPersistTaps="handled"
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (state.phase === 'ready' && state.hasMore && !state.loadingMore) loadMore();
      }}
      ListHeaderComponent={header}
      ListEmptyComponent={
        state.phase === 'loading' ? (
          <Loading label="Loading your library" />
        ) : state.phase === 'error' ? (
          <View style={{ gap: theme.space(3) }}>
            <Notice tone="error">{state.message}</Notice>
            <Button label="Try again" onPress={retry} />
          </View>
        ) : (
          empty
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
                onPress={loadMore}
              />
            )}
            {!state.hasMore && items.length > 0 && <Muted>That is everything.</Muted>}
          </View>
        ) : undefined
      }
    />
  );
}
