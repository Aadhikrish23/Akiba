import { useAuth } from '../../../auth/AuthContext';
import { Body, Heading, Screen } from '../../../components/ui';

export default function HomeScreen() {
  const { state } = useAuth();
  const name = state.status === 'signed-in' ? (state.user.displayName ?? state.user.email) : '';
  return (
    <Screen>
      <Heading>Welcome, {name}</Heading>
      <Body>Your library and what to watch next will be here.</Body>
    </Screen>
  );
}
