import { describeError } from '@akiba/api-client';
import {
  ENTRY_LABEL,
  ENTRY_STATUSES,
  type EntryStatus,
  type LibraryEntryDetail,
  type TitleDetail,
} from '@akiba/shared';
import { useCallback, useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { formatDay } from '../lib/format';
import { useTitleNames } from '../lib/useTitleNames';
import { MIN_TARGET, useTheme } from '../theme/theme';
import { Chips, type Choice } from './Chips';
import { PlusOne } from './PlusOne';
import { Body, Button, Field, Heading, Muted, Notice } from './ui';

const STATUS_CHOICES: Choice<EntryStatus>[] = ENTRY_STATUSES.map((value) => ({
  value,
  label: ENTRY_LABEL[value],
}));

const RATINGS: Choice<string>[] = [
  { value: '', label: 'Not rated' },
  ...Array.from({ length: 10 }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  })),
];

type Alerts = 'on' | 'off';

/**
 * The reader's own shelf for one title (doc 08 key flows 2–4): add it, change its status, rate,
 * favourite, review, watch it again, correct its episode count, turn episode alerts on or off for
 * it, and remove it. Every change is confirmed by the server before the screen shows it.
 */
export function ShelfPanel({ title }: { title: TitleDetail }) {
  const { client, profile } = useAuth();
  const theme = useTheme();
  const name = useTitleNames().name(title);
  const zone = profile?.timeZone ?? 'UTC';
  const [entry, setEntry] = useState<LibraryEntryDetail | null>(null);
  const [loading, setLoading] = useState(title.libraryEntryId !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addStatus, setAddStatus] = useState<EntryStatus>(
    title.status === 'releasing' ? 'watching' : 'planned',
  );
  const [review, setReview] = useState('');
  const [totalDraft, setTotalDraft] = useState('');
  const [editingTotal, setEditingTotal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(
    (id: string) => {
      setLoading(true);
      client.library
        .get(id)
        .then((value) => {
          setEntry(value);
          setReview(value.review ?? '');
        })
        .catch((caught: unknown) => {
          setError(describeError(caught).message);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [client],
  );
  useEffect(() => {
    if (title.libraryEntryId !== null) load(title.libraryEntryId);
  }, [title.libraryEntryId, load]);

  const run = async (action: () => Promise<LibraryEntryDetail | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setEntry(next);
      if (next !== null) setReview(next.review ?? '');
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Muted>Loading your shelf…</Muted>;

  if (entry === null) {
    return (
      <View style={{ gap: theme.space(3) }}>
        <Heading level={2}>Add to your library</Heading>
        {error !== null && <Notice tone="error">{error}</Notice>}
        <Chips
          label="Status"
          choices={STATUS_CHOICES}
          value={addStatus}
          onChange={(value) => value !== '' && setAddStatus(value)}
        />
        <Button
          label="Add to library"
          variant="primary"
          busy={busy}
          onPress={() => void run(() => client.library.add(title.id, addStatus))}
        />
      </View>
    );
  }

  const change = (changes: Parameters<typeof client.library.update>[1]) =>
    run(() => client.library.update(entry.id, changes));

  return (
    <View style={{ gap: theme.space(5) }}>
      <Heading level={2}>On your shelf</Heading>
      {error !== null && <Notice tone="error">{error}</Notice>}

      <Chips
        label="Status"
        choices={STATUS_CHOICES}
        value={entry.status}
        onChange={(value) => value !== '' && void change({ status: value })}
      />
      <Chips
        label="Your rating"
        choices={RATINGS}
        value={entry.rating === null ? '' : String(entry.rating)}
        onChange={(value) => void change({ rating: value === '' ? null : Number(value) })}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: MIN_TARGET,
        }}
      >
        <Text style={{ color: theme.colors.ink, fontSize: theme.type.base * 1.07 }}>Favorite</Text>
        <Switch
          accessibilityLabel="Favorite"
          value={entry.isFavorite}
          onValueChange={(value) => void change({ isFavorite: value })}
          trackColor={{ true: theme.colors.ink, false: theme.colors.rule }}
          thumbColor={theme.colors.paper}
        />
      </View>
      {entry.status === 'watching' && (
        <Chips
          label="Episode alerts for this title"
          choices={[
            { value: '', label: 'Follow my account setting' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          value={entry.alertsEnabled === null ? '' : entry.alertsEnabled ? 'on' : 'off'}
          onChange={(value: Alerts | '') =>
            void change({ alertsEnabled: value === '' ? null : value === 'on' })
          }
        />
      )}

      {entry.status !== 'completed' ? (
        <PlusOne entry={entry} name={name} />
      ) : (
        <View style={{ gap: theme.space(3) }}>
          <Body>
            Completed {entry.progress} of {entry.effectiveTotal ?? '?'} episodes.
          </Body>
          <Button
            label="Rewatch"
            busy={busy}
            accessibilityLabel={`Rewatch ${name}`}
            onPress={() => void run(() => client.library.startRun(entry.id))}
          />
        </View>
      )}

      <View style={{ gap: theme.space(2) }}>
        {entry.totalOverridden && (
          <View style={{ gap: theme.space(1) }}>
            <Body>Edited. The episode count is your own: {entry.effectiveTotal}.</Body>
            <Button
              label={`Reset to ${title.episodesTotal ?? 'unknown'}`}
              variant="link"
              onPress={() => void run(() => client.library.clearEpisodesTotal(entry.id))}
            />
          </View>
        )}
        {!editingTotal ? (
          <Button
            label="Episode count looks wrong?"
            variant="link"
            onPress={() => {
              setTotalDraft(String(entry.effectiveTotal ?? ''));
              setEditingTotal(true);
            }}
          />
        ) : (
          <View style={{ gap: theme.space(3) }}>
            <Field
              label="Number of episodes"
              value={totalDraft}
              onChangeText={setTotalDraft}
              keyboardType="number-pad"
            />
            <View style={{ flexDirection: 'row', gap: theme.space(3) }}>
              <Button
                label="Save"
                busy={busy}
                onPress={() =>
                  void run(() =>
                    client.library.setEpisodesTotal(entry.id, Number(totalDraft)),
                  ).then(() => {
                    setEditingTotal(false);
                  })
                }
              />
              <Button
                label="Cancel"
                onPress={() => {
                  setEditingTotal(false);
                }}
              />
            </View>
          </View>
        )}
      </View>

      <View style={{ gap: theme.space(3) }}>
        <Field label="Your review (private)" value={review} onChangeText={setReview} multiline />
        <Button
          label="Save review"
          busy={busy}
          onPress={() => void change({ review: review.trim() === '' ? null : review })}
        />
      </View>

      {entry.runs.length > 0 && (
        <View style={{ gap: theme.space(2) }}>
          <Heading level={2}>Viewings</Heading>
          {entry.runs.map((viewing) => (
            <Text
              key={viewing.id}
              style={{ color: theme.colors.ink, fontSize: theme.type.sm * 1.1 }}
            >
              Run {viewing.runNumber}: started {formatDay(viewing.startedAt, zone)}
              {viewing.finishedAt === null
                ? ', in progress'
                : `, finished ${formatDay(viewing.finishedAt, zone)}`}
              {viewing.rating !== null && `, rated ${viewing.rating} / 10`}
            </Text>
          ))}
        </View>
      )}

      {!confirmRemove ? (
        <Button
          label="Remove from library"
          variant="link"
          onPress={() => {
            setConfirmRemove(true);
          }}
        />
      ) : (
        <View style={{ gap: theme.space(2) }}>
          <Notice tone="error">Remove this title? Your viewings are kept.</Notice>
          <View style={{ flexDirection: 'row', gap: theme.space(4), flexWrap: 'wrap' }}>
            <Button
              label="Yes, remove it"
              variant="link"
              onPress={() =>
                void run(async () => {
                  await client.library.remove(entry.id);
                  setConfirmRemove(false);
                  return null;
                })
              }
            />
            <Button
              label="Keep it"
              variant="link"
              onPress={() => {
                setConfirmRemove(false);
              }}
            />
          </View>
        </View>
      )}
    </View>
  );
}
