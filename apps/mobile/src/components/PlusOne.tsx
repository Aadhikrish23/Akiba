import type { LibraryEntry } from '@akiba/shared';
import { Text, View } from 'react-native';
import { useEntryProgress } from '../lib/progress';
import { useTheme } from '../theme/theme';
import { Button, Notice } from './ui';

/** A 4 pt bar on a track that is visible on its own (doc 08 §6: the track has contrast). */
export function ProgressMeter({
  progress,
  total,
  label,
}: {
  progress: number;
  total: number | null;
  label: string;
}) {
  const theme = useTheme();
  const percent = total === null || total === 0 ? 0 : Math.min(100, (progress / total) * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: total ?? undefined, now: progress }}
      style={{
        height: 4,
        borderRadius: theme.radius,
        backgroundColor: theme.colors.rule,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${percent}%`,
          height: '100%',
          backgroundColor: theme.colors.accent,
        }}
      />
    </View>
  );
}

/** `16 / 28`, in a serif (doc 08 §8). */
export function EpisodeCount({ progress, total }: { progress: number; total: number | null }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityLabel={`${progress} of ${total ?? 'unknown'} episodes`}
      style={{
        color: theme.colors.ink,
        fontFamily: theme.fonts.serif,
        fontSize: theme.type.lg,
        fontVariant: ['tabular-nums'],
      }}
    >
      {progress}
      <Text style={{ color: theme.colors.mute }}> / {total ?? '?'}</Text>
    </Text>
  );
}

/**
 * The "+1 episode" control and its inline follow-ups: an error, and "Mark completed?" at the final
 * episode. Used by Home, the library and the title screen, so it behaves the same everywhere.
 */
export function PlusOne({ entry, name }: { entry: LibraryEntry; name: string }) {
  const theme = useTheme();
  const track = useEntryProgress(entry);
  return (
    <View style={{ gap: theme.space(2) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(3) }}>
        <EpisodeCount progress={track.progress} total={entry.effectiveTotal} />
        {track.canAdvance && (
          <Button
            label="+1 episode"
            accessibilityLabel={`+1 episode of ${name}`}
            onPress={() => void track.plusOne()}
          />
        )}
      </View>
      <ProgressMeter
        progress={track.progress}
        total={entry.effectiveTotal}
        label={`Progress in ${name}`}
      />
      {track.error !== null && <Notice tone="error">{track.error}</Notice>}
      {track.suggest && (
        <View style={{ gap: theme.space(1) }}>
          <Notice>That was the last episode. Mark completed?</Notice>
          <View style={{ flexDirection: 'row', gap: theme.space(4), flexWrap: 'wrap' }}>
            <Button
              label="Yes, mark completed"
              variant="link"
              busy={track.busy}
              onPress={() => void track.complete()}
            />
            <Button label="Not yet" variant="link" onPress={track.dismissSuggestion} />
          </View>
        </View>
      )}
    </View>
  );
}
