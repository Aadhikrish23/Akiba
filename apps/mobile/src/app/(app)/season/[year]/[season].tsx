import { SEASONS, SEASON_LABEL, shiftSeason, type Season } from '@akiba/shared';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '../../../../auth/AuthContext';
import { TitleResults } from '../../../../components/TitleResults';
import { Heading, TextLink } from '../../../../components/ui';
import { useTitleList } from '../../../../lib/useTitleList';
import { useTheme } from '../../../../theme/theme';

const isSeason = (value: string | undefined): value is Season =>
  (SEASONS as readonly string[]).includes(value ?? '');

/** Validates the address, then shows the chart; an invalid one goes to the current season. */
export default function SeasonScreen() {
  const params = useLocalSearchParams<{ year: string; season: string }>();
  const year = Number(params.year);
  const season = params.season;
  if (!Number.isInteger(year) || year < 1940 || year > 2100 || !isSeason(season)) {
    return <Redirect href="/season/current" />;
  }
  return <SeasonChart year={year} season={season} />;
}

/**
 * The seasonal chart (FR-DISC-003): one season at a time, with links to the one before and after,
 * so the current and adjacent seasons are one tap apart.
 */
function SeasonChart({ year, season }: { year: number; season: Season }) {
  const { client } = useAuth();
  const theme = useTheme();
  const label = `${SEASON_LABEL[season]} ${year}`;
  const { state, loadMore, retry } = useTitleList(`${year}-${season}`, (cursor) =>
    client.titles.season(year, season, { limit: 24, ...(cursor === undefined ? {} : { cursor }) }),
  );
  const before = shiftSeason({ season, year }, -1);
  const after = shiftSeason({ season, year }, 1);
  const to = (value: { season: Season; year: number }) => ({
    pathname: '/season/[year]/[season]' as const,
    params: { year: value.year, season: value.season },
  });

  return (
    <>
      <Stack.Screen options={{ title: label }} />
      <TitleResults
        state={state}
        onRetry={retry}
        onLoadMore={loadMore}
        empty="No titles are listed for this season yet."
        header={
          <View style={{ gap: theme.space(2) }}>
            <Heading>{label}</Heading>
            <TextLink
              href={to(before)}
            >{`← ${SEASON_LABEL[before.season]} ${before.year}`}</TextLink>
            <TextLink href={to(after)}>{`${SEASON_LABEL[after.season]} ${after.year} →`}</TextLink>
          </View>
        }
      />
    </>
  );
}
