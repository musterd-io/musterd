import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useCalendar } from '../data/calendar-context';
import { radius, space, usePalette } from '../ui/theme';

/**
 * Where the daemon is, which Team, and the Member's credential (ADR 519 §4, ADR 520 §5). Connecting
 * reads the calendar once before anything is kept, so a typo is refused here rather than showing up
 * later as an empty calendar.
 */
export default function SettingsScreen() {
  const p = usePalette();
  const cal = useCalendar();
  const [server, setServer] = useState(cal.connection?.server ?? '');
  const [team, setTeam] = useState(cal.connection?.team ?? '');
  const [credential, setCredential] = useState(cal.connection?.credential ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setProblem(null);
    try {
      await cal.connect({ server, team, credential: credential.trim() });
      router.back();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    extra: object = {},
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.text, backgroundColor: p.surface, borderColor: p.border }]}
        {...extra}
      />
    </View>
  );

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: p.bg }}
    >
      {input('Server', server, setServer, {
        placeholder: 'http://your-laptop.tailnet.ts.net:4849',
        keyboardType: 'url',
      })}
      <Text style={[styles.hint, { color: p.muted }]}>
        Your laptop’s Tailscale name and the daemon’s port. The daemon must list that name in
        MUSTERD_ALLOWED_HOSTS.
      </Text>
      {input('Team', team, setTeam, { placeholder: 'revive' })}
      {input('Credential', credential, setCredential, {
        placeholder: 'mscr_…',
        secureTextEntry: true,
      })}
      <Text style={[styles.hint, { color: p.muted }]}>
        Your human credential. It is kept in the iOS Keychain on this phone only.
      </Text>
      {problem ? <Text style={[styles.problem, { color: p.danger }]}>{problem}</Text> : null}
      <Pressable
        onPress={() => void connect()}
        disabled={busy}
        style={[styles.button, { backgroundColor: p.accent, opacity: busy ? 0.6 : 1 }]}
      >
        <Text style={[styles.buttonText, { color: p.onAccent }]}>
          {busy ? 'Checking…' : 'Connect'}
        </Text>
      </Pressable>
      {cal.connection ? (
        <Pressable
          onPress={() => void cal.disconnect().then(() => router.back())}
          style={[styles.button, styles.outline, { borderColor: p.danger }]}
        >
          <Text style={[styles.buttonText, { color: p.danger }]}>
            Disconnect and clear this phone
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md },
  field: { gap: space.xs },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 16,
  },
  hint: { fontSize: 12 },
  problem: { fontSize: 14 },
  button: { borderRadius: radius.sm, padding: space.md, alignItems: 'center', marginTop: space.sm },
  outline: { borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
