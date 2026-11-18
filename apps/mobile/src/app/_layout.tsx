import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { Loading } from '../components/ui';
import { ApiProvider, createAppClient } from '../lib/client';
import { ThemeProvider, useTheme } from '../theme/theme';

/**
 * The root of the app: providers, then the one decision everything else hangs on, whether anybody
 * is signed in. Signed-out visitors can only reach the `(auth)` screens and signed-in users can
 * only reach `(app)`; the router moves them across when the session starts or ends (a log-out, or
 * a session the server ended).
 */
export default function RootLayout() {
  const [client] = useState(createAppClient);
  return (
    <ApiProvider client={client}>
      <ThemeProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ThemeProvider>
    </ApiProvider>
  );
}

function Gate() {
  const { state } = useAuth();
  const theme = useTheme();
  if (state.status === 'loading') return <Loading label="Opening Akiba" />;
  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.paper },
        }}
      />
    </>
  );
}
