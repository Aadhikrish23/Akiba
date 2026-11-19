import { describeIssues } from '@akiba/api-client';
import { loginRequestSchema } from '@akiba/shared';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Body, Button, Field, Heading, Notice, Screen, TextLink } from '../../components/ui';
import { useForm } from '../../lib/useForm';

/** Restore an account that is in its 14-day grace period (FR-ACCT-002): the email and password prove it is theirs. */
export default function RestoreScreen() {
  const { client } = useAuth();
  const form = useForm();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <Screen>
        <Heading>Account restored</Heading>
        <Notice tone="success">
          Your account is back, with everything in it. Log in to continue.
        </Notice>
        <TextLink href="/login">Go to log in</TextLink>
      </Screen>
    );
  }

  const submit = () => {
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      form.fail(describeIssues(parsed.error.issues));
      return;
    }
    void form.run(async () => {
      await client.auth.restoreAccount(parsed.data);
      setDone(true);
    });
  };

  return (
    <Screen>
      <Body>Enter the email and password of the account you deleted.</Body>
      {form.problem !== null && <Notice tone="error">{form.problem.message}</Notice>}
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        error={form.fields['email']}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        error={form.fields['password']}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={submit}
      />
      <Button label="Restore account" variant="primary" busy={form.busy} onPress={submit} />
      <TextLink href="/login">Back to log in</TextLink>
    </Screen>
  );
}
