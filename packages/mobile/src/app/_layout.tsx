import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavBar } from '../ui/nav';
import { usePalette } from '../ui/theme';

export default function RootLayout() {
  const p = usePalette();
  // The theme still colours what the navigator draws itself (the screen behind a transition). The
  // app is light only.
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
    // ADR 815: the gesture root, so a sheet can be dragged shut anywhere in the app.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={theme}>
        <Stack
        screenOptions={{
          // The app's own bar (ui/nav.tsx), not the stock iOS one: nick on build 48 called the
          // "< Asks" bar "extremely generic and huge". It floats, transparent, over each screen's
          // warm glow; the screens pad their content by NAV_HEIGHT so nothing starts behind it.
          header: (props) => <NavBar {...props} />,
          headerTransparent: true,
          contentStyle: { backgroundColor: p.bg },
        }}
      >
        {/* ADR 814: the tabs are the shell; the rest push over them with the app's own bar. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: 'Pair' }} />
        <Stack.Screen name="ask/[ref]" options={{ title: 'Ask' }} />
        <Stack.Screen name="poll" options={{ title: 'Poll' }} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
