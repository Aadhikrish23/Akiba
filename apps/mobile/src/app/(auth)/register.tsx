import { describeIssues } from '@akiba/api-client';
import { registerRequestSchema } from '@akiba/shared';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Body, Button, Field, Heading, Notice, Screen, TextLink } from '../../components/ui';
import { useForm } from '../../lib/useForm';

export default function RegisterScreen() {
  const { client } = useAuth();
  const form = useForm();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (sentTo !== null) {
    return (
      <Screen>
        <Heading>Check your email</Heading>
        <Notice tone="success">
          We sent a link to {sentTo}. Open it to verify your address. You can already log in.
        </Notice>
        <TextLink href="/login">Go to log in</TextLink>
      </Screen>
    );
  }

  const submit = () => {
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
    <Screen>
      <Body>Akiba is free. Your library is private unless you share it.</Body>
      {form.problem !== null && <Notice tone="error">{form.problem.message}</Notice>}
      <Field
        label="Name"
        value={displayName}
        onChangeText={setDisplayName}
        error={form.fields['displayName']}
        autoComplete="name"
        textContentType="nickname"
        returnKeyType="next"
      />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        error={form.fields['email']}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        textContentType="emailAddress"
        returnKeyType="next"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        error={form.fields['password']}
        hint="At least 10 characters. A few random words work well."
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button label="Create account" variant="primary" busy={form.busy} onPress={submit} />
      <TextLink href="/login">Already have an account? Log in</TextLink>
    </Screen>
  );
}
