import { describeError } from '@akiba/api-client';
import { useState } from 'react';
import { useAuth } from '../../../auth/AuthContext';
import { Body, Button, Heading, Muted, Notice, Screen, TextLink } from '../../../components/ui';

export default function MeScreen() {
  const { state, client } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (state.status !== 'signed-in') return null;

  const signOut = () => {
    setBusy(true);
    setError(null);
    client.auth
      .logout()
      .catch((caught: unknown) => {
        // The local session is gone either way; say so only if the server could not be told.
        setError(describeError(caught).message);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Screen>
      <Heading>{state.user.displayName ?? 'Your account'}</Heading>
      <Body>{state.user.email}</Body>
      {!state.user.emailVerified && <Muted>Your email address is not verified yet.</Muted>}
      <TextLink href="/settings">Settings</TextLink>
      {error !== null && <Notice tone="error">{error}</Notice>}
      <Button label="Log out" busy={busy} onPress={signOut} />
    </Screen>
  );
}
