import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, space, usePalette } from '../ui/theme';

/**
 * The asks list (ADR 676 §2). It says what the app is for until the list lands. Pairing is the
 * other route. An ask reaches this phone sealed and is answered with a Face ID signature, so
 * nothing here is fetched from the daemon over plain HTTP — the channel is the relay (ADR 676 §3).
 */
export default function AsksScreen() {
  const p = usePalette();
  const [note, setNote] = useState<string | null>(null);
  const [pairLabel, setPairLabel] = useState<string | null>(null);
  useEffect(() => {
    let subscription: { remove(): void } | undefined;
    let alive = true;
    void (async () => {
      try {
        // Dynamic: Expo Go has no native module, and the import throws there.
        const { watchNotificationAnswers } = await import('../native/notificationAnswers');
        if (!alive) return;
        subscription = watchNotificationAnswers(setNote);
      } catch {
        // The shell still opens. A dev build or TestFlight has the module.
      }
    })();
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { loadPairingPin } = await import('../native/pairingPin');
        const pin = await loadPairingPin();
        if (!alive) return;
        if (pin?.binding) setPairLabel(null);
        else setPairLabel(pin ? 'Finish pairing' : 'Pair this phone');
      } catch {
        if (alive) setPairLabel('Pair this phone');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <View style={[styles.body, { backgroundColor: p.bg }]}>
      <View style={[styles.dot, { backgroundColor: p.accent }]} />
      <Text style={[styles.title, { color: p.text }]}>No asks yet</Text>
      {note ? <Text style={[styles.copy, { color: p.text }]}>{note}</Text> : null}
      <Text style={[styles.copy, { color: p.muted }]}>
        Asks addressed to you arrive on this phone — sealed so only this phone can read them — and
        are answered with Face ID.
      </Text>
      {pairLabel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pairLabel}
          onPress={() => router.push('/pair')}
          style={[styles.pair, { backgroundColor: p.accent }]}
        >
          <Text style={[styles.pairText, { color: p.onAccent }]}>{pairLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  title: { fontSize: 20, fontWeight: '600' },
  copy: { fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 320 },
  pair: {
    minHeight: 44,
    marginTop: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pairText: { fontSize: 17, fontWeight: '600' },
});
