import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { Image } from 'react-native';
import wordmark from '../../assets/wordmark.png';
import { font, usePalette } from '../ui/theme';

export default function RootLayout() {
  const p = usePalette();
  // The navigator draws the header itself — its glass buttons and large title — from this theme,
  // not from the screens, so it gets the app's palette too. The large title never rendered even
  // with the theme (build 5), so the app uses the standard title bar. The app is light only.
  const base = DefaultTheme;
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
          headerTitleStyle: { color: p.text, fontFamily: font.semibold },
          headerStyle: { backgroundColor: p.bg },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: p.bg },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'Asks',
            // Transparent, so the home screen's warm glow runs up behind the wordmark.
            headerTransparent: true,
            headerStyle: { backgroundColor: 'transparent' },
            // The nameplate wordmark (ADR 704), rendered from docs/design/assets/wordmark.svg.
            headerTitle: () => (
              <Image
                source={wordmark}
                style={{ width: 122, height: 30 }}
                accessibilityLabel="musterd"
              />
            ),
          }}
        />
        <Stack.Screen name="pair" options={{ title: 'Pair' }} />
        <Stack.Screen name="ask/[ref]" options={{ title: 'Ask' }} />
      </Stack>
    </ThemeProvider>
  );
}
