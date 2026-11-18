import { SEASON_LABEL } from '@akiba/shared';
import { View } from 'react-native';
import { useAuth } from '../../../auth/AuthContext';
import { TitleRow } from '../../../components/TitleRow';
import { Button, Heading, Muted, Notice, Screen, TextLink } from '../../../components/ui';
import { useRemote } from '../../../lib/useRemote';
import { useTheme } from '../../../theme/theme';

/** Titles shown from the season on Home; the rest is one tap away. */
const SEASON_PREVIEW = 6;

export default function HomeScreen() {
  const { state, client } = useAuth();
  const theme = useTheme();
  const name = state.status === 'signed-in' ? (state.user.displayName ?? state.user.email) : '';
  const season = useRemote('home-season', () =>
    client.titles.currentSeason({ limit: SEASON_PREVIEW }),
  );

  return (
    <Screen>
      <Heading>Welcome, {name}</Heading>
      <View style={{ gap: theme.space(4) }}>
        <Heading level={2}>
          {season.state.phase === 'ready'
            ? `Airing this season · ${SEASON_LABEL[season.state.value.season]} ${season.state.value.seasonYear}`
            : 'Airing this season'}
        </Heading>
        {season.state.phase === 'loading' && <Muted>Loading…</Muted>}
        {(season.state.phase === 'error' || season.state.phase === 'missing') && (
          <View style={{ gap: theme.space(3) }}>
            <Notice tone="error">
              {season.state.phase === 'error'
                ? season.state.message
                : 'The seasonal chart is not available.'}
            </Notice>
            <Button label="Try again" onPress={season.retry} />
          </View>
        )}
        {season.state.phase === 'ready' && season.state.value.data.length === 0 && (
          <Muted>No titles are listed for this season yet.</Muted>
        )}
        {season.state.phase === 'ready' &&
          season.state.value.data
            .slice(0, SEASON_PREVIEW)
            .map((title) => <TitleRow key={title.id} title={title} />)}
        <TextLink href="/season/current">See the whole season</TextLink>
      </View>
    </Screen>
  );
}
