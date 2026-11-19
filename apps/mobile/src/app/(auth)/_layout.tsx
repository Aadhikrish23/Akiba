import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../auth/AuthContext';
import { useTheme } from '../../theme/theme';

/** The log-in screen is the way in (the files sort the other way round). */
export const unstable_settings = { anchor: 'login' };

/** Screens for somebody who is not signed in. A signed-in user has nothing to do here. */
export default function AuthLayout() {
  const { state } = useAuth();
  const theme = useTheme();
  if (state.status === 'signed-in') return <Redirect href="/(app)/(tabs)" />;
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: theme.fonts.serif },
        headerStyle: { backgroundColor: theme.colors.paper },
        headerTintColor: theme.colors.ink,
        contentStyle: { backgroundColor: theme.colors.paper },
      }}
    >
      <Stack.Screen name="login" options={{ title: 'Log in', headerBackVisible: false }} />
      <Stack.Screen name="register" options={{ title: 'Create an account' }} />
      <Stack.Screen name="restore" options={{ title: 'Restore your account' }} />
      <Stack.Screen
        name="account-deleted"
        options={{ title: 'Account deleted', headerBackVisible: false }}
      />
      <Stack.Screen name="forgot-password" options={{ title: 'Reset your password' }} />
    </Stack>
  );
}
