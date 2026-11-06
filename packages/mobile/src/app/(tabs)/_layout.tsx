import { Tabs } from 'expo-router';
import { ChromeProvider } from '../../ui/chrome';
import { TabBar } from '../../ui/tabBar';
import { usePalette } from '../../ui/theme';

/**
 * The shell (ADR 814 decision 5): three tabs under the floating pill. Now is first and is where the
 * app opens; Work and You come in their own phases. No stock header: each screen draws its own,
 * over its warm glow. `lazy: false` so a tab switch is a slide, not a load.
 */
export default function TabsLayout() {
  const p = usePalette();
  return (
    <ChromeProvider>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{
          headerShown: false,
          lazy: false,
          sceneStyle: { backgroundColor: p.bg },
        }}
      >
        <Tabs.Screen name="now" options={{ title: 'Now' }} />
        <Tabs.Screen name="work" options={{ title: 'Work' }} />
        <Tabs.Screen name="you" options={{ title: 'You' }} />
      </Tabs>
    </ChromeProvider>
  );
}
