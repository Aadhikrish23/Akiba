import { Redirect } from 'expo-router';
import { useAuth } from '../auth/AuthContext';

/** `/` is neither a signed-in nor a signed-out screen: it sends each visitor where they belong. */
export default function Index() {
  const { state } = useAuth();
  return <Redirect href={state.status === 'signed-in' ? '/(app)/(tabs)' : '/login'} />;
}
