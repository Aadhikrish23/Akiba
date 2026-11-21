import { describeError } from '@akiba/api-client';
import {
  ENTRY_LABEL,
  ENTRY_STATUSES,
  TITLE_LANGUAGES,
  type EntryStatus,
  type ShareCreated,
  type ShareStatus,
  type TitleLanguage,
  type UpdateProfileRequest,
} from '@akiba/shared';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Share, Switch, Text, View } from 'react-native';
import { useAuth } from '../../auth/AuthContext';
import { Chips } from '../../components/Chips';
import { Body, Button, Field, Heading, Muted, Notice, Screen } from '../../components/ui';
import { MIN_TARGET, useTheme } from '../../theme/theme';

const LANGUAGE_LABEL: Record<TitleLanguage, string> = {
  romaji: 'Romaji',
  english: 'English',
  native: 'Japanese',
};

/** One saved-or-failed message, announced politely, gone on the next change. */
function useFeedback() {
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  return {
    message,
    ok: (text: string) => {
      setMessage({ tone: 'success', text });
    },
    fail: (error: unknown) => {
      setMessage({ tone: 'error', text: describeError(error).message });
    },
    clear: () => {
      setMessage(null);
    },
  };
}
type Feedback = ReturnType<typeof useFeedback>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space(3) }}>
      <Heading level={2}>{title}</Heading>
      {children}
    </View>
  );
}

function FeedbackNotice({ feedback }: { feedback: Feedback }) {
  return feedback.message === null ? null : (
    <Notice tone={feedback.message.tone}>{feedback.message.text}</Notice>
  );
}

function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space(1) }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space(3),
          minHeight: MIN_TARGET,
        }}
      >
        <Text style={{ flex: 1, color: theme.colors.ink, fontSize: theme.type.base * 1.07 }}>
          {label}
        </Text>
        <Switch
          accessibilityLabel={label}
          value={value}
          onValueChange={onChange}
          trackColor={{ true: theme.colors.ink, false: theme.colors.rule }}
          thumbColor={theme.colors.paper}
        />
      </View>
      {hint !== undefined && <Muted>{hint}</Muted>}
    </View>
  );
}

/** Whether this device knows the time zone (a typo should not be saved to the account). */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings (FR-ACCT-001, FR-EXPT-001, FR-SHARE-001/002, FR-ACCT-002): the title language, time zone,
 * alerts and adult setting; export; the share link; deleting the account. Appearance follows the
 * device's light or dark setting.
 */
export default function SettingsScreen() {
  const { profile } = useAuth();
  return (
    <Screen style={{ gap: 32 }}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Heading>Settings</Heading>
      {profile === null ? <Muted>Loading your settings…</Muted> : <Preferences />}
      <ExportSection />
      <ShareSection />
      <DeleteSection />
    </Screen>
  );
}

function Preferences() {
  const { profile, updateProfile } = useAuth();
  const feedback = useFeedback();
  const [zone, setZone] = useState(profile?.timeZone ?? 'UTC');
  const [alerts, setAlerts] = useState(profile?.alertsEnabled ?? true);
  const [adult, setAdult] = useState(profile?.showAdult ?? false);
  const [language, setLanguage] = useState<TitleLanguage>(profile?.titleLanguage ?? 'romaji');
  const [zoneError, setZoneError] = useState<string | undefined>();

  /** Save at once; put the control back if the account could not be changed. */
  const save = (changes: UpdateProfileRequest, undo: () => void) => {
    feedback.clear();
    updateProfile(changes)
      .then(() => {
        feedback.ok('Saved.');
      })
      .catch((error: unknown) => {
        undo();
        feedback.fail(error);
      });
  };

  return (
    <Section title="Preferences">
      <FeedbackNotice feedback={feedback} />
      <Chips
        label="Show titles in"
        choices={TITLE_LANGUAGES.map((value) => ({ value, label: LANGUAGE_LABEL[value] }))}
        value={language}
        onChange={(value) => {
          if (value === '') return;
          const before = language;
          setLanguage(value);
          save({ titleLanguage: value }, () => {
            setLanguage(before);
          });
        }}
      />
      <Field
        label="Time zone"
        value={zone}
        onChangeText={(value) => {
          setZone(value);
          setZoneError(undefined);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        error={zoneError}
        hint="For example Europe/London or Asia/Tokyo. Airing times and dates use it."
      />
      <Button
        label="Save time zone"
        onPress={() => {
          const value = zone.trim();
          if (!knownZone(value)) {
            setZoneError('Time zone is not one this device knows. Use a name like Asia/Tokyo.');
            return;
          }
          save({ timeZone: value }, () => undefined);
        }}
      />
      <SwitchRow
        label="Tell me when a new episode of a show I am watching airs"
        value={alerts}
        onChange={(value) => {
          setAlerts(value);
          save({ alertsEnabled: value }, () => {
            setAlerts(!value);
          });
        }}
      />
      <SwitchRow
        label="Show adult-rated titles"
        hint="Off by default. Adult-rated titles are left out of Discover and cannot be opened or added while this is off."
        value={adult}
        onChange={(value) => {
          setAdult(value);
          save({ showAdult: value }, () => {
            setAdult(!value);
          });
        }}
      />
      <Muted>Light or dark follows your device's setting.</Muted>
    </Section>
  );
}

/**
 * Export (FR-EXPT-001): the file is handed to the system share sheet as text, so it can be saved to
 * Files, sent to a mail app or copied. (Large libraries can exceed what some apps accept as a
 * message; the web app downloads a real file.)
 */
function ExportSection() {
  const { client } = useAuth();
  const feedback = useFeedback();
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null);

  const run = (format: 'json' | 'csv') => {
    feedback.clear();
    setBusy(format);
    client.account
      .exportFile(format)
      .then((file) => Share.share({ title: file.filename, message: file.text }))
      .then((result) => {
        if (result.action === Share.sharedAction) feedback.ok('Shared.');
      })
      .catch(feedback.fail)
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <Section title="Your data">
      <Muted>
        Everything you did, as a file you keep. The JSON file has all of it (and can be read back by
        Akiba); the CSV is your library as a spreadsheet.
      </Muted>
      <FeedbackNotice feedback={feedback} />
      <Button label="Export as JSON" busy={busy === 'json'} onPress={() => run('json')} />
      <Button label="Export as CSV" busy={busy === 'csv'} onPress={() => run('csv')} />
    </Section>
  );
}

function ShareSection() {
  const { client, state } = useAuth();
  const feedback = useFeedback();
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [created, setCreated] = useState<ShareCreated | null>(null);
  const [statuses, setStatuses] = useState<EntryStatus[]>(['completed']);
  const [showRatings, setShowRatings] = useState(false);
  const [showReviews, setShowReviews] = useState(false);
  const [busy, setBusy] = useState(false);
  const theme = useTheme();
  const verified = state.status === 'signed-in' && state.user.emailVerified;

  useEffect(() => {
    let live = true;
    client.account
      .getShare()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch((error: unknown) => {
        if (live) feedback.fail(error);
      });
    return () => {
      live = false;
    };
  }, [client]);

  const act = (work: () => Promise<void>) => {
    feedback.clear();
    setBusy(true);
    work()
      .catch(feedback.fail)
      .finally(() => {
        setBusy(false);
      });
  };
  const create = () =>
    act(async () => {
      const link = await client.account.putShare({ statuses, showRatings, showReviews });
      setCreated(link);
      setStatus({ active: true, scope: link.scope, createdAt: link.createdAt });
    });
  const revoke = () =>
    act(async () => {
      await client.account.revokeShare();
      setCreated(null);
      setStatus({ active: false, scope: null, createdAt: null });
      feedback.ok('The link is revoked. It stopped working at once.');
    });
  const toggle = (value: EntryStatus) => {
    setStatuses((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  return (
    <Section title="Share your list">
      <Muted>
        A link anyone can open to see part of your library, read-only, without an account. You
        choose what it shows, and you can turn it off at any time.
      </Muted>
      <FeedbackNotice feedback={feedback} />
      {!verified && <Notice>Verify your email address to create a share link.</Notice>}
      <View style={{ gap: theme.space(1) }}>
        <Text style={{ color: theme.colors.ink, fontWeight: '500' }}>Show titles that are</Text>
        {ENTRY_STATUSES.map((value) => (
          <SwitchRow
            key={value}
            label={ENTRY_LABEL[value]}
            value={statuses.includes(value)}
            onChange={() => {
              toggle(value);
            }}
          />
        ))}
      </View>
      <SwitchRow label="Show my ratings" value={showRatings} onChange={setShowRatings} />
      <SwitchRow label="Show my reviews" value={showReviews} onChange={setShowReviews} />
      <Button
        label={status?.active === true ? 'Make a new link' : 'Create link'}
        variant="primary"
        busy={busy}
        disabled={!verified || statuses.length === 0}
        onPress={create}
      />
      {status?.active === true && <Button label="Turn sharing off" busy={busy} onPress={revoke} />}
      {status?.active === true && created === null && (
        <Muted>
          A link is active. For your safety it is shown only when it is made; make a new link to get
          a fresh one (the old one stops working).
        </Muted>
      )}
      {created !== null && (
        <View style={{ gap: theme.space(2) }}>
          <Field
            label="Your link (shown once)"
            value={created.url}
            editable={false}
            selectTextOnFocus
          />
          <Button
            label="Share the link"
            onPress={() => {
              Share.share({ message: created.url }).catch(feedback.fail);
            }}
          />
        </View>
      )}
    </Section>
  );
}

function DeleteSection() {
  const { client, setDeleting } = useAuth();
  const router = useRouter();
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    feedback.clear();
    setBusy(true);
    // The session ends on purpose; this keeps the frame from bouncing to log-in first.
    setDeleting(true);
    client.account
      .deleteAccount(password)
      .then((result) => {
        router.replace({ pathname: '/account-deleted', params: { purgeAfter: result.purgeAfter } });
        setDeleting(false);
      })
      .catch((error: unknown) => {
        setDeleting(false);
        feedback.fail(error);
        setBusy(false);
      });
  };

  return (
    <Section title="Delete your account">
      <Muted>
        Your account and everything in it will be erased after 14 days. Until then you can change
        your mind and restore it by logging in again.
      </Muted>
      <FeedbackNotice feedback={feedback} />
      {!open ? (
        <Button
          label="Delete my account…"
          onPress={() => {
            setOpen(true);
          }}
        />
      ) : (
        <View style={{ gap: 12 }}>
          <Body>Type your password to confirm.</Body>
          <Field
            label="Your password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
          />
          <Button label="Delete my account" variant="primary" busy={busy} onPress={submit} />
          <Button
            label="Cancel"
            variant="link"
            onPress={() => {
              setOpen(false);
              setPassword('');
            }}
          />
        </View>
      )}
    </Section>
  );
}
