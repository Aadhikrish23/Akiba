import { Redirect, Stack } from 'expo-router';
import { useAuth } from '../../auth/AuthContext';
import { InboxProvider } from '../../lib/inbox';
import { useTheme } from '../../theme/theme';

/**
 * Everything for a signed-in user: the tabs, and the screens pushed on top of them. Nobody else
 * gets in: a visitor with no session (or whose session just ended, by log-out or because the server
 * ended it) is sent to the log-in screen.
 */
export default function AppLayout() {
  const { state, deleting } = useAuth();
  const theme = useTheme();
  // A deletion in progress ends the session on purpose; its own screen takes over.
  if (state.status !== 'signed-in' && deleting) return null;
  if (state.status !== 'signed-in') return <Redirect href="/login" />;
  return (
    <InboxProvider>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTitleStyle: { fontFamily: theme.fonts.serif },
          headerStyle: { backgroundColor: theme.colors.paper },
          headerTintColor: theme.colors.ink,
          contentStyle: { backgroundColor: theme.colors.paper },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </InboxProvider>
  );
}
