import { Tabs } from 'expo-router';
import { MIN_TARGET, useTheme } from '../../../theme/theme';

/** The five destinations of doc 08 §4: Home · Discover · Library · Inbox · Me. */
export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: theme.fonts.serif },
        headerStyle: { backgroundColor: theme.colors.paper },
        headerTintColor: theme.colors.ink,
        sceneStyle: { backgroundColor: theme.colors.paper },
        tabBarActiveTintColor: theme.colors.ink,
        tabBarInactiveTintColor: theme.colors.mute,
        tabBarStyle: {
          backgroundColor: theme.colors.paper,
          borderTopColor: theme.colors.rule,
          minHeight: MIN_TARGET + 16,
        },
        tabBarLabelStyle: { fontSize: theme.type.sm * 1.1, fontWeight: '500' },
        tabBarIconStyle: { display: 'none' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="discover" options={{ title: 'Discover' }} />
      <Tabs.Screen name="library" options={{ title: 'Library' }} />
      <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="me" options={{ title: 'Me' }} />
    </Tabs>
  );
}
