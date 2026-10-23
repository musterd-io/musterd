import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { radius, space, usePalette } from '../ui/theme';

/**
 * The asks list (ADR 676 §2). Until pairing and the list land it says what the app is for rather
 * than showing an empty frame: an ask reaches this phone sealed and is answered with a Face ID
 * signature, so nothing here is fetched from the daemon over plain HTTP — the channel is the relay
 * (ADR 676 §3).
 */
export default function AsksScreen() {
  const p = usePalette();
  const [note, setNote] = useState<string | null>(null);
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
  return (
    <View style={[styles.body, { backgroundColor: p.bg }]}>
      <View style={[styles.dot, { backgroundColor: p.accent }]} />
      <Text style={[styles.title, { color: p.text }]}>No asks yet</Text>
      {note ? <Text style={[styles.copy, { color: p.text }]}>{note}</Text> : null}
      <Text style={[styles.copy, { color: p.muted }]}>
        Asks addressed to you arrive on this phone — sealed so only this phone can read them — and
        are answered with Face ID.
      </Text>
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
});
