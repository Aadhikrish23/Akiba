import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
} from '@akiba/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, Notice } from '../components/ui';
import { AuthLayout } from '../layout/AuthLayout';
import { describeError, describeIssues, type Described } from '../lib/errors';

const LINK = 'underline underline-offset-4';

/** Shared plumbing of the auth forms: field errors, one top-level message, a busy flag. */
function useFormState() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Described | null>(null);
  const notice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A failed submit moves focus to the message, so it is read out and the fields are one Tab away.
    if (problem !== null) notice.current?.focus();
  }, [problem]);

  return {
    busy,
    problem,
    notice,
    fields: problem?.fields ?? {},
    fail: (fields: Record<string, string>, message = 'Check the highlighted fields.') => {
      setProblem({ message, fields });
    },
    run: async (action: () => Promise<void>) => {
      setBusy(true);
      setProblem(null);
      try {
        await action();
      } catch (error) {
        setProblem(describeError(error));
      } finally {
        setBusy(false);
      }
    },
  };
}

function ProblemNotice({ form }: { form: ReturnType<typeof useFormState> }) {
  if (form.problem === null) return null;
  return (
    <Notice tone="error" focusRef={form.notice}>
      {form.problem.message}
    </Notice>
  );
}

/** A signed-in visitor has nothing to do on these screens. */
function useGate(): 'loading' | 'redirect' | 'ready' {
  const { state } = useAuth();
  if (state.status === 'loading') return 'loading';
  return state.status === 'signed-in' ? 'redirect' : 'ready';
}

function Waiting({ title }: { title: string }) {
  return (
    <AuthLayout title={title}>
      <p aria-busy="true" className="text-mute">
        Loading…
      </p>
    </AuthLayout>
  );
}

/** Emailed links carry their token in the URL fragment so it never reaches a server log (T5). */
function tokenFromHash(hash: string): string | null {
  const match = /^#token=([^&\s]+)/.exec(hash);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

export function LoginPage() {
  const gate = useGate();
  const { client, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const form = useFormState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (gate === 'loading') return <Waiting title="Log in" />;
  if (gate === 'redirect') return <Navigate to="/" replace />;

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      form.fail(describeIssues(parsed.error.issues));
      return;
    }
    void form.run(async () => {
      const user = await client.auth.login(parsed.data);
      setUser(user);
      void navigate(from, { replace: true });
    });
  };

  return (
    <AuthLayout
      title="Log in"
      footer={
        <p>
          New to Akiba?{' '}
          <Link to="/register" className={LINK}>
            Create an account
          </Link>
        </p>
      }
    >
      <form onSubmit={submit} noValidate className="grid gap-5">
        <ProblemNotice form={form} />
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          error={form.fields['email']}
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          error={form.fields['password']}
        />
        <div className="flex items-center justify-between gap-4">
          <Button type="submit" variant="primary" busy={form.busy}>
            Log in
          </Button>
          <Link to="/forgot-password" className={`text-sm ${LINK}`}>
            Forgot your password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const gate = useGate();
  const { client } = useAuth();
  const form = useFormState();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (gate === 'loading') return <Waiting title="Create an account" />;
  if (gate === 'redirect') return <Navigate to="/" replace />;

  if (sentTo !== null) {
    return (
      <AuthLayout title="Check your email">
        <Notice tone="success">
          We sent a link to <strong>{sentTo}</strong>. Open it to verify your address. You can
          already log in.
        </Notice>
        <p>
          <Link to="/login" className={LINK}>
            Go to log in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = registerRequestSchema.safeParse({ email, password, displayName });
    if (!parsed.success) {
      form.fail(describeIssues(parsed.error.issues));
      return;
    }
    void form.run(async () => {
      await client.auth.register(parsed.data);
      setSentTo(parsed.data.email);
    });
  };

  return (
    <AuthLayout
      title="Create an account"
      intro="Akiba is free. Your library is private unless you share it."
      footer={
        <p>
          Already have an account?{' '}
          <Link to="/login" className={LINK}>
            Log in
          </Link>
        </p>
      }
    >
      <form onSubmit={submit} noValidate className="grid gap-5">
        <ProblemNotice form={form} />
        <Field
          label="Name"
          name="displayName"
          autoComplete="nickname"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
          error={form.fields['displayName']}
        />
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          error={form.fields['email']}
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          hint="At least 10 characters. A few random words work well."
          error={form.fields['password']}
        />
        <div>
          <Button type="submit" variant="primary" busy={form.busy}>
            Create account
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const { client, state, refresh } = useAuth();
  const location = useLocation();
  const [result, setResult] = useState<'verifying' | 'verified' | 'failed' | 'no-token'>(
    'verifying',
  );
  const [problem, setProblem] = useState<Described | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // The link is single-use: never spend it twice (StrictMode runs effects twice in development).
    if (started.current) return;
    started.current = true;
    const token = tokenFromHash(location.hash);
    if (token === null) {
      setResult('no-token');
      return;
    }
    // The token has done its job once read; do not leave it in the address bar or history.
    window.history.replaceState(null, '', location.pathname);
    client.auth
      .verifyEmail(token)
      .then(async () => {
        setResult('verified');
        if (client.isSignedIn()) await refresh().catch(() => undefined);
      })
      .catch((error: unknown) => {
        setProblem(describeError(error));
        setResult('failed');
      });
  }, [client, location.hash, location.pathname, refresh]);

  const home = state.status === 'signed-in';
  return (
    <AuthLayout title="Verify your email">
      {result === 'verifying' && (
        <p role="status" aria-busy="true" className="text-mute">
          Verifying your address…
        </p>
      )}
      {result === 'verified' && (
        <>
          <Notice tone="success">Your email address is verified.</Notice>
          <p>
            <Link to={home ? '/' : '/login'} className={LINK}>
              {home ? 'Continue to Akiba' : 'Log in'}
            </Link>
          </p>
        </>
      )}
      {result === 'failed' && (
        <>
          <Notice tone="error">{problem?.message ?? 'The link could not be used.'}</Notice>
          <p>
            <Link to={home ? '/' : '/login'} className={LINK}>
              {home ? 'Go to Akiba to request a new link' : 'Log in to request a new link'}
            </Link>
          </p>
        </>
      )}
      {result === 'no-token' && (
        <Notice tone="error">This link is incomplete. Open the link from your email again.</Notice>
      )}
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const { client } = useAuth();
  const form = useFormState();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = forgotPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      form.fail(describeIssues(parsed.error.issues));
      return;
    }
    void form.run(async () => {
      await client.auth.forgotPassword(parsed.data);
      setSent(true);
    });
  };

  if (sent) {
    return (
      <AuthLayout title="Check your email">
        <Notice tone="success">
          If an account exists for that address, we sent a link to reset the password. It works for
          one hour.
        </Notice>
        <p>
          <Link to="/login" className={LINK}>
            Back to log in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password" intro="Enter your email and we will send you a link.">
      <form onSubmit={submit} noValidate className="grid gap-5">
        <ProblemNotice form={form} />
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
          error={form.fields['email']}
        />
        <div className="flex items-center justify-between gap-4">
          <Button type="submit" variant="primary" busy={form.busy}>
            Send link
          </Button>
          <Link to="/login" className={`text-sm ${LINK}`}>
            Back to log in
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { client } = useAuth();
  const location = useLocation();
  const form = useFormState();
  // Read once and kept in state: the fragment is removed from the address bar below.
  const [token] = useState(() => tokenFromHash(location.hash));
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (token !== null) window.history.replaceState(null, '', location.pathname);
  }, [token, location.pathname]);

  if (token === null) {
    return (
      <AuthLayout title="Reset your password">
        <Notice tone="error">
          This link is incomplete. Open the link from your email again, or request a new one.
        </Notice>
        <p>
          <Link to="/forgot-password" className={LINK}>
            Request a new link
          </Link>
        </p>
      </AuthLayout>
    );
  }
  if (done) {
    return (
      <AuthLayout title="Password changed">
        <Notice tone="success">
          Your password is changed and every device has been logged out.
        </Notice>
        <p>
          <Link to="/login" className={LINK}>
            Log in
          </Link>
        </p>
      </AuthLayout>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = resetPasswordRequestSchema.safeParse({ token, newPassword });
    if (!parsed.success) {
      form.fail(describeIssues(parsed.error.issues));
      return;
    }
    if (newPassword !== confirm) {
      form.fail({ confirm: 'The two passwords do not match.' });
      return;
    }
    void form.run(async () => {
      await client.auth.resetPassword(parsed.data);
      setDone(true);
    });
  };

  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={submit} noValidate className="grid gap-5">
        <ProblemNotice form={form} />
        <Field
          label="New password"
          type="password"
          name="newPassword"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
          }}
          hint="At least 10 characters."
          error={form.fields['newPassword']}
        />
        <Field
          label="Repeat the new password"
          type="password"
          name="confirm"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
          }}
          error={form.fields['confirm']}
        />
        <div>
          <Button type="submit" variant="primary" busy={form.busy}>
            Change password
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
