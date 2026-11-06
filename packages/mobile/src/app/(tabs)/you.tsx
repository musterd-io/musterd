import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Roster } from '../../native/quickAction';
import { Button } from '../../ui/button';
import { Backdrop } from '../../ui/glass';
import { Rise } from '../../ui/motion';
import { font, space, usePalette } from '../../ui/theme';

/**
 * You: your passkeys, this phone, notifications; the team's hours and policies — phase 5 of the
 * app shell design. Today it carries the one thing that moved here from Seats: starting a Twitch
 * poll (ADR 807), which the roster offers to an admin's phone.
 */
export default function YouScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [roster, setRoster] = useState<Roster | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void (async () => {
        try {
          const { loadPairingPin } = await import('../../native/pairingPin');
          const pin = await loadPairingPin();
          if (!live || !pin?.binding) return;
          const { fetchRoster } = await import('../../native/quickAction');
          const got = await fetchRoster({ pin });
          if (live && !('miss' in got)) setRoster(got);
        } catch {
          // Expo Go has no native module.
        }
      })();
      return () => {
        live = false;
      };
    }, []),
  );
  return (
    <View style={[styles.screen, { backgroundColor: p.bg, paddingTop: insets.top + space.lg }]}>
      <Backdrop />
      <Rise>
        <Text style={[styles.title, { color: p.text }]}>You</Text>
        <Text style={[styles.body, { color: p.muted }]}>
          Your passkeys, this phone and your team’s settings will live here.
        </Text>
      </Rise>
      {roster?.poll ? (
        <Rise index={1} style={styles.poll}>
          <Button
            label={roster.poll.open ? 'Open the poll' : 'Start a poll'}
            kind="secondary"
            icon="chart.bar"
            onPress={() => router.push('/poll')}
          />
        </Rise>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space.lg },
  title: { fontFamily: font.display, fontSize: 28, letterSpacing: -0.4 },
  body: { fontFamily: font.regular, fontSize: 14, marginTop: space.xs },
  poll: { marginTop: space.lg, alignSelf: 'flex-start' },
});
