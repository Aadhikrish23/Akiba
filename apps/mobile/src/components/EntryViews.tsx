import { ENTRY_LABEL, metaLine, type LibraryEntry } from '@akiba/shared';
import { Link } from 'expo-router';
import { Image, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useTitleNames } from '../lib/useTitleNames';
import { useTheme } from '../theme/theme';
import { PlusOne, ProgressMeter } from './PlusOne';

const COVER_WIDTH = 56;
const COVER_HEIGHT = 84;

/**
 * A library entry as a row (the list layout and Home's "Continue watching"): the cover and name are
 * one link to the title; the +1 control sits under it, outside the link, so a tap on it is never a
 * tap on the row.
 */
export function EntryRow({ entry }: { entry: LibraryEntry }) {
  const theme = useTheme();
  const name = useTitleNames().name(entry.title);
  return (
    <View style={{ gap: theme.space(3) }}>
      <Link href={{ pathname: '/title/[id]', params: { id: entry.title.id } }} asChild>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${name}, ${ENTRY_LABEL[entry.status]}, ${metaLine(entry.title)}`}
          // A plain object: `Link asChild` does not pass a function style on.
          style={{ flexDirection: 'row', gap: theme.space(3), minHeight: COVER_HEIGHT }}
        >
          <View
            style={{
              width: COVER_WIDTH,
              height: COVER_HEIGHT,
              borderRadius: theme.radius,
              borderWidth: theme.hairline,
              borderColor: theme.colors.rule,
              backgroundColor: theme.colors.raised,
              overflow: 'hidden',
            }}
          >
            {entry.title.coverUrl !== null && (
              <Image
                source={{ uri: entry.title.coverUrl }}
                accessible={false}
                accessibilityIgnoresInvertColors
                style={{ width: COVER_WIDTH, height: COVER_HEIGHT }}
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
            <Text style={{ color: theme.colors.mute, fontSize: theme.type.sm * 1.1 }}>
              {ENTRY_LABEL[entry.status]} · {metaLine(entry.title)}
              {entry.rating === null ? '' : ` · Rated ${entry.rating} / 10`}
            </Text>
          </View>
        </Pressable>
      </Link>
      <PlusOne entry={entry} name={name} />
    </View>
  );
}

const GRID_GAP = 16;
const GRID_PADDING = 16;

/** A library entry as a poster in the two-column grid, with its progress on the cover's bottom edge. */
export function EntryPoster({ entry }: { entry: LibraryEntry }) {
  const theme = useTheme();
  const name = useTitleNames().name(entry.title);
  const { width } = useWindowDimensions();
  const cellWidth = Math.floor((width - GRID_PADDING * 2 - GRID_GAP) / 2);
  const coverHeight = Math.round((cellWidth * 3) / 2);
  const total = entry.effectiveTotal;
  return (
    <Link href={{ pathname: '/title/[id]', params: { id: entry.title.id } }} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${name}, ${ENTRY_LABEL[entry.status]}, ${entry.progress} of ${total ?? 'unknown'} episodes`}
        style={{ width: cellWidth, gap: theme.space(2), minHeight: 44 }}
      >
        <View
          style={{
            width: cellWidth,
            height: coverHeight,
            borderRadius: theme.radius,
            borderWidth: theme.hairline,
            borderColor: theme.colors.rule,
            backgroundColor: theme.colors.raised,
            overflow: 'hidden',
            justifyContent: 'center',
          }}
        >
          {entry.title.coverUrl === null ? (
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
              source={{ uri: entry.title.coverUrl }}
              accessible={false}
              accessibilityIgnoresInvertColors
              style={{ width: cellWidth, height: coverHeight }}
            />
          )}
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
            <ProgressMeter progress={entry.progress} total={total} label={`Progress in ${name}`} />
          </View>
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: theme.colors.ink,
            fontFamily: theme.fonts.serif,
            fontWeight: '600',
            fontSize: theme.type.base * 1.07,
          }}
        >
          {name}
        </Text>
        <Text style={{ color: theme.colors.mute, fontSize: theme.type.sm * 1.1 }}>
          {ENTRY_LABEL[entry.status]} · {entry.progress} / {total ?? '?'}
        </Text>
      </Pressable>
    </Link>
  );
}

export const GRID = { gap: GRID_GAP, padding: GRID_PADDING } as const;
