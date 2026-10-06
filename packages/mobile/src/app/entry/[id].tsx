import {
  CALENDAR_DEFAULT_TZ,
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  CalendarEntryInputSchema,
  type CalendarEntry,
  type CalendarKind,
  type CalendarStatus,
} from '@musterd/protocol/calendar';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useCalendar } from '../../data/calendar-context';
import { deviceTimeZone } from '../../lib/views';
import { Chip } from '../../ui/components';
import { KIND_COLORS, radius, space, usePalette } from '../../ui/theme';

/** The form's state: every field as the person types it, before the protocol schema reads it. */
interface Draft {
  title: string;
  date: string;
  start: string;
  end: string;
  tz: string;
  kind: CalendarKind;
  status: CalendarStatus | null;
  place: string;
  url: string;
  note: string;
  pick: boolean;
}

function draftOf(e: CalendarEntry | undefined, date: string | undefined): Draft {
  return {
    title: e?.title ?? '',
    date: e?.date ?? date ?? '',
    start: e?.start ?? '',
    end: e?.end ?? '',
    tz: e?.tz ?? CALENDAR_DEFAULT_TZ,
    kind: e?.kind ?? 'event',
    status: e?.status ?? null,
    place: e?.place ?? '',
    url: e?.url ?? '',
    note: e?.note ?? '',
    pick: e?.pick ?? false,
  };
}

export default function EntryScreen() {
  const p = usePalette();
  const cal = useCalendar();
  const { id, date } = useLocalSearchParams<{ id: string; date?: string }>();
  const existing = cal.entries.find((e) => e.id === id);
  const [d, setD] = useState<Draft>(() => draftOf(existing, date));
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  if (id !== 'new' && !existing) {
    return (
      <Text style={[styles.gone, { color: p.muted }]}>
        This entry is no longer on the calendar.
      </Text>
    );
  }

  async function save() {
    // The protocol schema is the form's validator — the phone refuses exactly what the daemon would.
    const parsed = CalendarEntryInputSchema.safeParse({
      title: d.title,
      date: d.date.trim(),
      start: d.start.trim() || null,
      end: d.end.trim() || null,
      tz: d.tz.trim(),
      kind: d.kind,
      status: d.status,
      place: d.place,
      url: d.url.trim() || null,
      note: d.note,
      pick: d.pick,
      // An edit keeps where the entry came from and its import key.
      source: existing?.source ?? '',
      source_ref: existing?.source_ref ?? null,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setProblem(issue ? `${issue.path.join('.') || 'entry'}: ${issue.message}` : 'invalid entry');
      return;
    }
    await cal.save(parsed.data, existing ?? null);
    router.back();
  }

  function confirmDelete() {
    if (!existing) return;
    Alert.alert('Delete this entry?', existing.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void cal.remove(existing).then(() => router.back());
        },
      },
    ]);
  }

  const field = (
    label: string,
    key: 'title' | 'date' | 'start' | 'end' | 'tz' | 'place' | 'url' | 'note',
    props: TextInputProps = {},
  ) => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <TextInput
        value={d[key]}
        onChangeText={(v) => set(key, v)}
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.text, backgroundColor: p.surface, borderColor: p.border }]}
        {...props}
      />
    </View>
  );

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: p.bg }}
    >
      <Stack.Screen
        options={{
          title: existing ? 'Edit' : 'New entry',
          headerRight: () => (
            <Pressable onPress={() => void save()} hitSlop={8}>
              <Text style={[styles.save, { color: p.accentText }]}>Save</Text>
            </Pressable>
          ),
        }}
      />
      {problem ? <Text style={[styles.problem, { color: p.danger }]}>{problem}</Text> : null}
      {field('Title', 'title', { placeholder: 'Pitch practice with…', autoFocus: !existing })}
      <View style={styles.rowFields}>
        <View style={styles.grow}>
          {field('Date', 'date', {
            placeholder: 'YYYY-MM-DD',
            keyboardType: 'numbers-and-punctuation',
          })}
        </View>
        <View style={styles.time}>
          {field('Start', 'start', {
            placeholder: 'HH:MM',
            keyboardType: 'numbers-and-punctuation',
          })}
        </View>
        <View style={styles.time}>
          {field('End', 'end', { placeholder: 'HH:MM', keyboardType: 'numbers-and-punctuation' })}
        </View>
      </View>
      {d.tz !== deviceTimeZone() ? (
        <Text style={[styles.hint, { color: p.warning }]}>
          Times are on {d.tz} clocks, not this phone’s.
        </Text>
      ) : null}

      <Text style={[styles.label, { color: p.muted }]}>Kind</Text>
      <View style={styles.wrap}>
        {CALENDAR_KINDS.map((k) => (
          <Chip
            key={k}
            label={k}
            color={KIND_COLORS[k]}
            on={d.kind === k}
            onPress={() => set('kind', k)}
          />
        ))}
      </View>

      <Text style={[styles.label, { color: p.muted }]}>Status</Text>
      <View style={styles.wrap}>
        <Chip label="none" on={d.status === null} onPress={() => set('status', null)} />
        {CALENDAR_STATUSES.map((s) => (
          <Chip key={s} label={s} on={d.status === s} onPress={() => set('status', s)} />
        ))}
      </View>

      <View style={[styles.pickRow, { borderColor: p.border }]}>
        <Text style={{ color: p.text, fontSize: 16 }}>Pick</Text>
        <Switch
          value={d.pick}
          onValueChange={(v) => set('pick', v)}
          trackColor={{ true: p.accent }}
        />
      </View>

      {field('Place', 'place', { placeholder: 'Where' })}
      {field('Link', 'url', {
        placeholder: 'https://…',
        autoCapitalize: 'none',
        keyboardType: 'url',
        autoCorrect: false,
      })}
      {field('Note', 'note', {
        multiline: true,
        style: [
          styles.input,
          styles.note,
          { color: p.text, backgroundColor: p.surface, borderColor: p.border },
        ],
      })}
      {field('Time zone', 'tz', { autoCapitalize: 'none', autoCorrect: false })}

      {existing ? (
        <Pressable onPress={confirmDelete} style={[styles.delete, { borderColor: p.danger }]}>
          <Text style={{ color: p.danger, fontWeight: '600' }}>Delete entry</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  gone: { padding: space.xl, textAlign: 'center' },
  save: { fontSize: 17, fontWeight: '600' },
  problem: { fontSize: 14 },
  field: { gap: space.xs },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 16,
  },
  note: { minHeight: 96, textAlignVertical: 'top' },
  rowFields: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  time: { width: 80 },
  hint: { fontSize: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  delete: {
    marginTop: space.lg,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: space.md,
    alignItems: 'center',
  },
});
