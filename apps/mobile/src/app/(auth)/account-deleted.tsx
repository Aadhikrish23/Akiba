import { useLocalSearchParams } from 'expo-router';
import { Body, Heading, Notice, Screen, TextLink } from '../../components/ui';
import { formatDay } from '../../lib/format';

/** Shown after the account is scheduled for deletion: what happens, and how to undo it. */
export default function AccountDeletedScreen() {
  const { purgeAfter } = useLocalSearchParams<{ purgeAfter?: string }>();
  return (
    <Screen>
      <Heading>Your account is scheduled for deletion</Heading>
      <Notice>
        You are logged out
        {purgeAfter === undefined
          ? ''
          : `, and your data will be erased after ${formatDay(purgeAfter, 'UTC')}`}
        . Until then you can restore the account.
      </Notice>
      <Body>Changed your mind? Restoring brings everything back exactly as it was.</Body>
      <TextLink href="/restore">Restore my account</TextLink>
      <TextLink href="/login">Back to log in</TextLink>
    </Screen>
  );
}
