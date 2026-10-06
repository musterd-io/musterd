import type { CalendarEntry, CalendarKind } from '@musterd/protocol/calendar';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SyncReport } from '../lib/sync';
import { timeLabel, zoneNote } from '../lib/views';
import { KIND_COLORS, radius, space, usePalette } from './theme';

/** A row of mutually exclusive options — Upcoming / Month / Past, Picks / Everything. */
export function Segmented<T extends string>(props: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(v: T): void;
}) {
  const p = usePalette();
  return (
    <View style={[styles.segmented, { backgroundColor: p.raised }]} accessibilityRole="tablist">
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChange(o.value)}
            style={[styles.segment, on && { backgroundColor: p.surface }]}
          >
            <Text style={[styles.segmentText, { color: on ? p.text : p.muted }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip(props: { label: string; on: boolean; color?: string; onPress(): void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      hitSlop={4}
      style={[
        styles.chip,
        {
          borderColor: props.on ? p.accent : p.border,
          backgroundColor: props.on ? p.raised : 'transparent',
        },
      ]}
    >
      {props.color ? <View style={[styles.dot, { backgroundColor: props.color }]} /> : null}
      <Text style={[styles.chipText, { color: props.on ? p.text : p.muted }]}>{props.label}</Text>
    </Pressable>
  );
}

export function KindDot({ kind, size = 8 }: { kind: CalendarKind; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: KIND_COLORS[kind],
      }}
    />
  );
}

export function EntryRow(props: { entry: CalendarEntry; deviceTz: string; onPress(): void }) {
  const p = usePalette();
  const e = props.entry;
  const zone = zoneNote(e, props.deviceTz);
  const meta = [e.kind, e.status, e.place].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? p.raised : p.surface, borderColor: p.border },
      ]}
    >
      <View style={styles.rowTime}>
        <Text style={[styles.rowTimeText, { color: p.muted }]}>{timeLabel(e)}</Text>
        {zone ? <Text style={[styles.rowZone, { color: p.warning }]}>{zone}</Text> : null}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <KindDot kind={e.kind} />
          <Text style={[styles.rowTitle, { color: p.text }]} numberOfLines={2}>
            {e.title}
          </Text>
          {e.pick ? <Text style={{ color: p.accent }}>★</Text> : null}
        </View>
        {meta ? (
          <Text style={[styles.rowMeta, { color: p.muted }]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** What the last sync did, in one line — and every dropped edit, by name. */
export function SyncLine(props: {
  report: SyncReport | null;
  syncing: boolean;
  lastSyncedAt: number | null;
  now: number;
}) {
  const p = usePalette();
  const r = props.report;
  let line: string;
  if (props.syncing) line = 'Syncing…';
  else if (r?.offline) line = 'Offline — showing the copy on this phone';
  else if (r?.error) line = `Sync failed: ${r.error}`;
  else if (props.lastSyncedAt) line = `Synced ${ago(props.now - props.lastSyncedAt)}`;
  else line = 'Not synced yet';
  return (
    <View style={styles.syncBox}>
      <Text style={[styles.syncText, { color: r?.error ? p.danger : p.muted }]}>{line}</Text>
      {r?.dropped.map((d, i) => (
        <Text key={i} style={[styles.syncText, { color: p.warning }]}>
          “{d.title}” — {d.reason}
        </Text>
      ))}
    </View>
  );
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const styles = StyleSheet.create({
  segmented: { flexDirection: 'row', borderRadius: radius.sm, padding: 2 },
  segment: {
    flex: 1,
    paddingVertical: space.sm,
    alignItems: 'center',
    borderRadius: radius.sm - 2,
  },
  segmentText: { fontSize: 14, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipText: { fontSize: 13, fontWeight: '500' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  row: {
    flexDirection: 'row',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowTime: { width: 84 },
  rowTimeText: { fontSize: 13, fontVariant: ['tabular-nums'] },
  rowZone: { fontSize: 11, marginTop: 2 },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowTitle: { flex: 1, fontSize: 16, fontWeight: '500' },
  rowMeta: { fontSize: 13 },
  syncBox: { gap: 2 },
  syncText: { fontSize: 12 },
});
