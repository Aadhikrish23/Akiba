import {
  ENTRY_STATUSES,
  TITLE_LANGUAGES,
  type EntryStatus,
  type ShareCreated,
  type ShareStatus,
  type TitleLanguage,
} from '@akiba/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, Notice, Select } from '../components/ui';
import { describeError } from '../lib/errors';
import { usePageTitle } from '../lib/page';
import { applyTheme, readTheme, type ThemeChoice } from '../lib/theme';
import { ENTRY_LABEL } from '../lib/titles';

const LANGUAGE_LABEL: Record<TitleLanguage, string> = {
  romaji: 'Romaji (Shingeki no Kyojin)',
  english: 'English (Attack on Titan)',
  native: 'Japanese (進撃の巨人)',
};

/** One saved-or-failed message that is announced politely and goes away on the next change. */
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

function Feedback({ feedback }: { feedback: ReturnType<typeof useFeedback> }) {
  return feedback.message === null ? null : (
    <Notice tone={feedback.message.tone}>{feedback.message.text}</Notice>
  );
}

const timeZones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** Settings (FR-ACCT-001, FR-EXPT-001, FR-SHARE-001/002, FR-ACCT-002): profile, theme, export, share, delete. */
export function SettingsPage() {
  usePageTitle('Settings');
  const { profile } = useAuth();
  return (
    <div className="grid max-w-3xl gap-12">
      <h1 className="h-title">Settings</h1>
      {profile === null ? (
        <p role="status" aria-busy="true" className="text-mute">
          Loading your settings…
        </p>
      ) : (
        <>
          <ProfileSection />
          <ThemeSection />
          <ExportSection />
          <ShareSection />
          <DeleteSection />
        </>
      )}
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="border-rule grid gap-4 border-t pt-6">
      <h2 id={id} className="h-section">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ProfileSection() {
  const { profile, updateProfile } = useAuth();
  const feedback = useFeedback();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [zone, setZone] = useState(profile?.timeZone ?? 'UTC');
  // The two switches answer at once; the save happens behind them.
  const [alerts, setAlerts] = useState(profile?.alertsEnabled ?? true);
  const [adult, setAdult] = useState(profile?.showAdult ?? false);
  const [busy, setBusy] = useState(false);
  if (profile === null) return null;

  const save = (changes: Parameters<typeof updateProfile>[0]) => {
    feedback.clear();
    setBusy(true);
    updateProfile(changes)
      .then(() => {
        feedback.ok('Saved.');
      })
      .catch(feedback.fail)
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Section id="profile-heading" title="Profile">
      <Feedback feedback={feedback} />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save({ displayName: name });
        }}
      >
        <div className="min-w-[14rem] flex-1">
          <Field
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            autoComplete="nickname"
          />
        </div>
        <Button type="submit" busy={busy}>
          Save name
        </Button>
      </form>
      <div className="grid gap-4 min-[560px]:grid-cols-2">
        <Select
          label="Show titles in"
          anyLabel=""
          value={profile.titleLanguage}
          options={TITLE_LANGUAGES.map((value) => ({ value, label: LANGUAGE_LABEL[value] }))}
          onChange={(event) => {
            save({ titleLanguage: event.target.value as TitleLanguage });
          }}
        />
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            save({ timeZone: zone });
          }}
          className="flex items-end gap-2"
        >
          <div className="flex-1">
            <Field
              label="Time zone"
              list="zones"
              value={zone}
              onChange={(event) => {
                setZone(event.target.value);
              }}
              hint="Air times are shown in this zone."
            />
            <datalist id="zones">
              {timeZones().map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </div>
          <Button type="submit" busy={busy}>
            Save
          </Button>
        </form>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={alerts}
          onChange={(event) => {
            setAlerts(event.target.checked);
            save({ alertsEnabled: event.target.checked });
          }}
        />
        Tell me when a new episode of a show I am watching airs
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={adult}
          onChange={(event) => {
            setAdult(event.target.checked);
            save({ showAdult: event.target.checked });
          }}
          className="mt-1"
        />
        <span>
          Show adult-rated titles
          <span className="text-mute block text-sm">
            Off by default. They stay out of search and browsing until you turn this on.
          </span>
        </span>
      </label>
    </Section>
  );
}

function ThemeSection() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return (
    <Section id="theme-heading" title="Appearance">
      <fieldset className="flex flex-wrap gap-6">
        <legend className="sr-only">Theme</legend>
        {(['system', 'light', 'dark'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="theme"
              value={value}
              checked={choice === value}
              onChange={() => {
                setChoice(value);
                applyTheme(value);
              }}
            />
            {value === 'system' ? 'Follow my device' : value === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </fieldset>
    </Section>
  );
}

function ExportSection() {
  const { client } = useAuth();
  const feedback = useFeedback();
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null);
  const download = (format: 'json' | 'csv') => {
    feedback.clear();
    setBusy(format);
    client.account
      .exportFile(format)
      .then((file) => {
        const url = URL.createObjectURL(new Blob([file.text], { type: file.contentType }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        feedback.ok(`Downloaded ${file.filename}.`);
      })
      .catch(feedback.fail)
      .finally(() => {
        setBusy(null);
      });
  };
  return (
    <Section id="export-heading" title="Export your data">
      <p className="text-mute max-w-prose">
        Everything you have done in Akiba, as a file you keep. The JSON file has your library,
        viewings and history; the CSV is a spreadsheet of your library.
      </p>
      <Feedback feedback={feedback} />
      <div className="flex flex-wrap gap-3">
        <Button
          onClick={() => {
            download('json');
          }}
          busy={busy === 'json'}
        >
          Download JSON
        </Button>
        <Button
          onClick={() => {
            download('csv');
          }}
          busy={busy === 'csv'}
        >
          Download CSV
        </Button>
      </div>
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
  const verified = state.status === 'signed-in' && state.user.emailVerified;

  useEffect(() => {
    let live = true;
    client.account
      .getShare()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch(feedback.fail);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <Section id="share-heading" title="Share your list">
      <p className="text-mute max-w-prose">
        A link anyone can open to see part of your library, read-only, without an account. You
        choose what it shows, and you can turn it off at any time.
      </p>
      <Feedback feedback={feedback} />
      {!verified && <Notice>Verify your email address to create a share link.</Notice>}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Show titles that are</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {ENTRY_STATUSES.map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={statuses.includes(value)}
                onChange={() => {
                  toggle(value);
                }}
              />
              {ENTRY_LABEL[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={showRatings}
          onChange={(event) => {
            setShowRatings(event.target.checked);
          }}
        />
        Show my ratings
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={showReviews}
          onChange={(event) => {
            setShowReviews(event.target.checked);
          }}
        />
        Show my reviews
      </label>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="primary"
          onClick={create}
          busy={busy}
          disabled={!verified || statuses.length === 0}
        >
          {status?.active === true ? 'Make a new link' : 'Create link'}
        </Button>
        {status?.active === true && (
          <Button onClick={revoke} busy={busy}>
            Turn sharing off
          </Button>
        )}
      </div>
      {status?.active === true && created === null && (
        <p className="text-mute max-w-prose text-sm">
          A link is active. For your safety it is shown only when it is made; make a new link to get
          a fresh one (the old one stops working).
        </p>
      )}
      {created !== null && (
        <div className="grid gap-2" role="status">
          <Field
            label="Your link (shown once)"
            readOnly
            value={created.url}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
          <div>
            <Button
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(created.url)
                  .then(() => {
                    feedback.ok('Link copied.');
                  })
                  .catch(() => {
                    feedback.ok('Select the link and copy it.');
                  });
              }}
            >
              Copy link
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function DeleteSection() {
  const { client, setDeleting } = useAuth();
  const navigate = useNavigate();
  const feedback = useFeedback();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    feedback.clear();
    setBusy(true);
    // The session ends on purpose; this flag keeps the frame from bouncing to log-in first.
    setDeleting(true);
    client.account
      .deleteAccount(password)
      .then((result) => {
        void navigate('/account-deleted', {
          replace: true,
          state: { purgeAfter: result.purgeAfter },
        });
      })
      .catch((error: unknown) => {
        setDeleting(false);
        feedback.fail(error);
        setBusy(false);
      });
  };
  return (
    <Section id="delete-heading" title="Delete your account">
      <p className="text-mute max-w-prose">
        This logs you out everywhere and turns off your share link. Your data is erased after 14
        days; until then you can restore the account.
      </p>
      <Feedback feedback={feedback} />
      {!open ? (
        <div>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Delete my account…
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid max-w-sm gap-4">
          <Field
            label="Your password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            hint="We ask again so that nobody else can do this from your open browser."
          />
          <div className="flex gap-3">
            <Button type="submit" variant="primary" busy={busy} disabled={password === ''}>
              Delete my account
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                setPassword('');
              }}
            >
              Keep it
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
