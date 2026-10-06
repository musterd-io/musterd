import { Stack } from 'expo-router';
import { CalendarProvider } from '../data/calendar-context';
import { usePalette } from '../ui/theme';

export default function RootLayout() {
  const p = usePalette();
  return (
    <CalendarProvider>
      <Stack
        screenOptions={{
          headerTintColor: p.accentText,
          headerTitleStyle: { color: p.text },
          headerStyle: { backgroundColor: p.bg },
          contentStyle: { backgroundColor: p.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Calendar', headerLargeTitle: true }} />
        <Stack.Screen name="entry/[id]" options={{ presentation: 'modal', title: 'Entry' }} />
        <Stack.Screen name="settings" options={{ presentation: 'modal', title: 'Connection' }} />
      </Stack>
    </CalendarProvider>
  );
}
