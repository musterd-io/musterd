import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';
import { usePalette } from '../ui/theme';

export default function RootLayout() {
  const p = usePalette();
  // The navigator draws the header itself — its glass buttons and large title — from this theme,
  // not from the screens. Left on its light default under a dark screen, build 2 drew light-grey
  // button pills and a black large title on black (2026-10-06, nick's phone). The large title
  // never rendered even with the theme (build 5), so the app uses the standard title bar.
  const base = useColorScheme() === 'dark' ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: p.accentText,
      background: p.bg,
      card: p.bg,
      text: p.text,
      border: p.border,
    },
  };
  return (
    <ThemeProvider value={theme}>
      <Stack
        screenOptions={{
          headerTintColor: p.accentText,
          headerTitleStyle: { color: p.text },
          headerStyle: { backgroundColor: p.bg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: p.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Asks' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair' }} />
      </Stack>
    </ThemeProvider>
  );
}
