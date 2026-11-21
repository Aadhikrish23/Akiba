import { ENTRY_LABEL, metaLine, type TitleCard } from '@akiba/shared';
import { Link } from 'expo-router';
import { Image, Pressable, Text, View } from 'react-native';
import { useTitleNames } from '../lib/useTitleNames';
import { useTheme } from '../theme/theme';

/** The cover size of a list row: 2:3, and big enough to recognise a show by. */
const COVER_WIDTH = 56;
const COVER_HEIGHT = 84;

/**
 * One title in a list (doc 08 §3): cover, name, a line of facts, and the reader's own status in
 * words. The whole row is one link, named by all of it, so a screen reader reads it once.
 */
export function TitleRow({ title }: { title: TitleCard }) {
  const theme = useTheme();
  const names = useTitleNames();
  const name = names.name(title);
  const facts = metaLine(title);
  const status = title.libraryStatus === null ? null : ENTRY_LABEL[title.libraryStatus];
  return (
    <Link href={{ pathname: '/title/[id]', params: { id: title.id } }} asChild>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={[name, facts, status].filter(Boolean).join(', ')}
        // A plain object, not a function of `pressed`: `Link asChild` does not pass a function style
        // on to the Pressable, and the row would lose its layout.
        style={{
          flexDirection: 'row',
          gap: theme.space(3),
          minHeight: COVER_HEIGHT,
        }}
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
            justifyContent: 'center',
          }}
        >
          {title.coverUrl !== null && (
            <Image
              source={{ uri: title.coverUrl }}
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
          <Text style={{ color: theme.colors.mute, fontSize: theme.type.sm * 1.1 }}>{facts}</Text>
          {status !== null && (
            <Text
              style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1, fontWeight: '500' }}
            >
              {status}
            </Text>
          )}
        </View>
      </Pressable>
    </Link>
  );
}
