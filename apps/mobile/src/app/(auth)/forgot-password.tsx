import { describeIssues } from '@akiba/api-client';
import { forgotPasswordRequestSchema } from '@akiba/shared';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Body, Button, Field, Heading, Notice, Screen, TextLink } from '../../components/ui';
import { useForm } from '../../lib/useForm';

export default function ForgotPasswordScreen() {
  const { client } = useAuth();
  const form = useForm();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <Screen>
        <Heading>Check your email</Heading>
        <Notice tone="success">
          If an account exists for that address, we sent a link to reset the password. It works for
          one hour. The link opens in your browser.
        </Notice>
        <TextLink href="/login">Back to log in</TextLink>
      </Screen>
    );
  }

  const submit = () => {
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

  return (
    <Screen>
      <Body>Enter your email and we will send you a link.</Body>
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
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <Button label="Send the link" variant="primary" busy={form.busy} onPress={submit} />
      <TextLink href="/login">Back to log in</TextLink>
    </Screen>
  );
}
