import { describeIssues } from '@akiba/api-client';
import { loginRequestSchema } from '@akiba/shared';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Body, Button, Field, Notice, Screen, TextLink } from '../../components/ui';
import { useForm } from '../../lib/useForm';

export default function LoginScreen() {
  const { client, setUser } = useAuth();
  const form = useForm();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = () => {
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      form.fail(describeIssues(parsed.error.issues));
      return;
    }
    void form.run(async () => {
      setUser(await client.auth.login(parsed.data));
    });
  };

  return (
    <Screen>
      <Body>Welcome back. Log in to see your library.</Body>
      {form.problem !== null && <Notice tone="error">{form.problem.message}</Notice>}
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
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button label="Log in" variant="primary" busy={form.busy} onPress={submit} />
      <TextLink href="/forgot-password">Forgot your password?</TextLink>
      <TextLink href="/register">Create an account</TextLink>
    </Screen>
  );
}
