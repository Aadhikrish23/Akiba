import {
  KIND_LABEL,
  RELATION_LABEL,
  ROLE_LABEL,
  SEASON_LABEL,
  STATUS_LABEL,
  type RelationsResponse,
  type TitleCharactersResponse,
} from '@akiba/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Image, Text, View } from 'react-native';
import { useAuth } from '../../../auth/AuthContext';
import { ShelfPanel } from '../../../components/ShelfPanel';
import { TitleRow } from '../../../components/TitleRow';
import { Body, Button, Heading, Muted, Notice, Screen } from '../../../components/ui';
import { formatMoment } from '../../../lib/format';
import { useRemote, type Remote } from '../../../lib/useRemote';
import { useTitleNames } from '../../../lib/useTitleNames';
import { useTheme } from '../../../theme/theme';

const COVER_WIDTH = 150;
const COVER_HEIGHT = 225;

/**
 * A title (FR-DISC-004, -005, -007): names, facts, where it airs next, the synopsis, what it is
 * related to and who is in it. Related titles and the cast load separately, so a slow or failed
 * lookup of either never hides the page.
 */
export default function TitleScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { client, profile } = useAuth();
  const theme = useTheme();
  const names = useTitleNames();
  const detail = useRemote(`title:${id}`, () => client.titles.detail(id));
  const relations = useRemote(`relations:${id}`, () => client.titles.relations(id));
  const cast = useRemote(`cast:${id}`, () => client.titles.characters(id));

  if (detail.state.phase === 'loading') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Title' }} />
        <Muted>Loading…</Muted>
      </Screen>
    );
  }
  if (detail.state.phase === 'missing') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Title not found' }} />
        <Heading>Title not found</Heading>
        <Body>This title does not exist, or it is not available.</Body>
      </Screen>
    );
  }
  if (detail.state.phase === 'error') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Title' }} />
        <Notice tone="error">{detail.state.message}</Notice>
        <Button label="Try again" onPress={detail.retry} />
      </Screen>
    );
  }

  const { data: title, meta } = detail.state.value;
  const name = names.name(title);
  const zone = profile?.timeZone ?? 'UTC';

  const facts: [string, string][] = [
    ['Format', title.format ?? KIND_LABEL[title.kind]],
    ['Status', STATUS_LABEL[title.status]],
  ];
  if (title.episodesTotal !== null) facts.push(['Episodes', String(title.episodesTotal)]);
  if (title.durationMin !== null) facts.push(['Episode length', `${title.durationMin} min`]);
  if (title.seasonYear !== null) {
    facts.push([
      'Season',
      title.season === null
        ? String(title.seasonYear)
        : `${SEASON_LABEL[title.season]} ${title.seasonYear}`,
    ]);
  }
  if (title.startDate !== null) facts.push(['Started', title.startDate]);
  if (title.endDate !== null) facts.push(['Ended', title.endDate]);
  if (title.averageScore !== null) facts.push(['Average score', `${title.averageScore} / 100`]);
  if (title.studios.length > 0) {
    facts.push(['Studios', title.studios.map((studio) => studio.name).join(', ')]);
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: name }} />
      <View style={{ flexDirection: 'row', gap: theme.space(4) }}>
        <View
          style={{
            width: COVER_WIDTH,
            height: COVER_HEIGHT,
            borderRadius: theme.radius,
            borderWidth: theme.hairline,
            borderColor: theme.colors.rule,
            backgroundColor: theme.colors.raised,
            overflow: 'hidden',
            justifyContent: 'center',
          }}
        >
          {title.coverUrl === null ? (
            <Text
              style={{
                color: theme.colors.mute,
                fontFamily: theme.fonts.serif,
                textAlign: 'center',
                padding: theme.space(2),
              }}
            >
              {name}
            </Text>
          ) : (
            <Image
              source={{ uri: title.coverUrl }}
              accessibilityLabel={`Cover of ${name}`}
              accessibilityIgnoresInvertColors
              style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
            />
          )}
        </View>
        <View style={{ flex: 1, gap: theme.space(1) }}>
          <Heading>{name}</Heading>
          {names.others(title).map((other) => (
            <Muted key={other.text}>{other.text}</Muted>
          ))}
        </View>
      </View>

      {meta.stale && (
        <Notice>
          This is the copy saved earlier: the anime catalog could not be reached just now, so some
          details may be out of date.
        </Notice>
      )}
      {title.nextAiring !== null && (
        <Body>
          Episode {title.nextAiring.episode} airs {formatMoment(title.nextAiring.airsAt, zone)}.
        </Body>
      )}

      <View style={{ gap: theme.space(2) }}>
        {facts.map(([term, value]) => (
          <Text
            key={term}
            accessibilityLabel={`${term}: ${value}`}
            style={{ color: theme.colors.ink, fontSize: theme.type.base * 1.07 }}
          >
            <Text style={{ color: theme.colors.mute }}>{term}: </Text>
            {value}
          </Text>
        ))}
      </View>
      {title.genres.length > 0 && <Body>Genres: {title.genres.join(', ')}</Body>}

      <ShelfPanel key={title.id} title={title} />

      {title.synopsis !== null && (
        <View style={{ gap: theme.space(3) }}>
          <Heading level={2}>Synopsis</Heading>
          {title.synopsis.split(/\n{2,}/).map((paragraph, index) => (
            <Body key={index}>{paragraph}</Body>
          ))}
        </View>
      )}

      <CastSection state={cast.state} retry={cast.retry} />
      <RelatedSection state={relations.state} retry={relations.retry} />
    </Screen>
  );
}

type CastState = Remote<TitleCharactersResponse>;
type RelatedState = Remote<RelationsResponse>;

function CastSection({ state, retry }: { state: CastState; retry: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space(3) }}>
      <Heading level={2}>Characters</Heading>
      {state.phase === 'loading' && <Muted>Loading characters…</Muted>}
      {(state.phase === 'error' || state.phase === 'missing') && (
        <View style={{ gap: theme.space(2) }}>
          <Notice>The characters could not be loaded just now.</Notice>
          <Button label="Try again" onPress={retry} />
        </View>
      )}
      {state.phase === 'ready' && state.value.data.length === 0 && (
        <Muted>No characters are listed for this title yet.</Muted>
      )}
      {state.phase === 'ready' &&
        state.value.data.map((character) => {
          const actor = character.voiceActors[0];
          return (
            <Text
              key={character.id}
              accessibilityLabel={`${character.name}, ${ROLE_LABEL[character.role]}${
                actor === undefined ? '' : `, voiced by ${actor.name}`
              }`}
              style={{ color: theme.colors.ink, fontSize: theme.type.base * 1.07 }}
            >
              {character.name}
              <Text style={{ color: theme.colors.mute }}>
                {` · ${ROLE_LABEL[character.role]}${actor === undefined ? '' : ` · voiced by ${actor.name}`}`}
              </Text>
            </Text>
          );
        })}
    </View>
  );
}

function RelatedSection({ state, retry }: { state: RelatedState; retry: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space(4) }}>
      <Heading level={2}>Related titles</Heading>
      {state.phase === 'loading' && <Muted>Loading related titles…</Muted>}
      {(state.phase === 'error' || state.phase === 'missing') && (
        <View style={{ gap: theme.space(2) }}>
          <Notice>Related titles could not be loaded just now.</Notice>
          <Button label="Try again" onPress={retry} />
        </View>
      )}
      {state.phase === 'ready' && state.value.data.length === 0 && (
        <Muted>Nothing is related to this title yet.</Muted>
      )}
      {state.phase === 'ready' &&
        state.value.data.map((group) => (
          <View key={group.relationType} style={{ gap: theme.space(3) }}>
            <Text
              accessibilityRole="header"
              style={{ color: theme.colors.mute, fontSize: theme.type.sm * 1.1, fontWeight: '600' }}
            >
              {(RELATION_LABEL[group.relationType] ?? group.relationType).toUpperCase()}
            </Text>
            {group.titles.map((related) => (
              <TitleRow key={related.id} title={related} />
            ))}
          </View>
        ))}
    </View>
  );
}
