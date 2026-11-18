import {
  KIND_LABEL,
  STATUS_LABEL,
  TITLE_KINDS,
  TITLE_STATUSES,
  type BrowseQuery,
  type TitleKind,
  type TitleSort,
  type TitleStatus,
} from '@akiba/shared';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useAuth } from '../../../auth/AuthContext';
import { Chips, type Choice } from '../../../components/Chips';
import { GenrePicker } from '../../../components/GenrePicker';
import { TitleResults } from '../../../components/TitleResults';
import { Button, Field, Heading, Muted, TextLink } from '../../../components/ui';
import { useTitleList } from '../../../lib/useTitleList';
import { useTheme } from '../../../theme/theme';

const SORT_LABEL: Record<Exclude<TitleSort, 'popularity'>, string> = {
  score: 'Highest rated',
  start_date: 'Newest',
};

const KINDS: Choice<TitleKind>[] = [
  { value: '', label: 'Any' },
  ...TITLE_KINDS.map((value) => ({ value, label: KIND_LABEL[value] })),
];
const STATUSES: Choice<TitleStatus>[] = [
  { value: '', label: 'Any' },
  ...TITLE_STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] })),
];
const SORTS: Choice<'score' | 'start_date'>[] = [
  { value: '', label: 'Most popular' },
  { value: 'score', label: SORT_LABEL.score },
  { value: 'start_date', label: SORT_LABEL.start_date },
];

/**
 * Discover (FR-DISC-001, -002, -006): search by name, or browse with filters. Status, genre and
 * sort apply to browsing only (the sources cannot combine them with a text search), so they are
 * switched off while a search is active, and the screen says why.
 */
export default function DiscoverScreen() {
  const { client } = useAuth();
  const theme = useTheme();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [format, setFormat] = useState<TitleKind | ''>('');
  const [status, setStatus] = useState<TitleStatus | ''>('');
  const [genre, setGenre] = useState('');
  const [sort, setSort] = useState<'score' | 'start_date' | ''>('');
  const [genres, setGenres] = useState<readonly string[]>([]);
  const searching = q !== '';

  useEffect(() => {
    let live = true;
    client.titles
      .genres()
      .then((names) => {
        if (live) setGenres(names);
      })
      .catch(() => {
        // The genre filter stays unavailable; everything else works.
      });
    return () => {
      live = false;
    };
  }, [client]);

  const key = useMemo(
    () => JSON.stringify({ q, format, status, genre, sort }),
    [q, format, status, genre, sort],
  );
  const { state, loadMore, retry } = useTitleList(key, (cursor) => {
    const paging = { limit: 24, ...(cursor === undefined ? {} : { cursor }) };
    if (searching) {
      return client.titles.search({
        q,
        ...paging,
        ...(format === '' ? {} : { format }),
      });
    }
    const browse: Partial<BrowseQuery> = {
      ...paging,
      ...(format === '' ? {} : { format }),
      ...(status === '' ? {} : { status }),
      ...(genre === '' ? {} : { genre }),
      ...(sort === '' ? {} : { sort }),
    };
    return client.titles.browse(browse);
  });

  const submit = () => {
    setQ(draft.trim());
  };

  const header = (
    <View style={{ gap: theme.space(4) }}>
      <Field
        label="Search by name"
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={submit}
      />
      <View style={{ flexDirection: 'row', gap: theme.space(3), flexWrap: 'wrap' }}>
        <Button label="Search" variant="primary" onPress={submit} />
        {searching && (
          <Button
            label="Clear search"
            onPress={() => {
              setDraft('');
              setQ('');
            }}
          />
        )}
      </View>
      <TextLink href="/season/current">Seasonal chart</TextLink>
      <Chips label="Format" choices={KINDS} value={format} onChange={setFormat} />
      <Chips
        label="Status"
        choices={STATUSES}
        value={status}
        onChange={setStatus}
        disabled={searching}
      />
      <GenrePicker genres={genres} value={genre} onChange={setGenre} disabled={searching} />
      <Chips label="Sort by" choices={SORTS} value={sort} onChange={setSort} disabled={searching} />
      {searching && (
        <Muted>Status, genre and sort apply when browsing. Clear the search to use them.</Muted>
      )}
      <Heading level={2}>{searching ? `Results for “${q}”` : 'Browse'}</Heading>
    </View>
  );

  return (
    <TitleResults
      state={state}
      header={header}
      onRetry={retry}
      onLoadMore={loadMore}
      empty={
        searching
          ? `Nothing matches “${q}”. Try a different spelling, or the original title.`
          : 'No titles match these filters. Remove one to see more.'
      }
    />
  );
}
