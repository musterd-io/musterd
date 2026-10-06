import { CALENDAR_KINDS, type CalendarKind } from '@musterd/protocol/calendar';
import { Link, router, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useCalendar } from '../data/calendar-context';
import {
  applyFilter,
  countByDate,
  dayHeading,
  deviceTimeZone,
  entriesOn,
  isOver,
  pastSections,
  shiftMonth,
  timeLabel,
  upcomingSections,
  upNext,
  wallClock,
  type Scope,
} from '../lib/views';
import { Chip, EntryRow, Segmented, SyncLine } from '../ui/components';
import { MonthView } from '../ui/month-view';
import { KIND_COLORS, radius, space, usePalette } from '../ui/theme';

type CalView = 'upcoming' | 'month' | 'past';

const VIEWS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'month', label: 'Month' },
  { value: 'past', label: 'Past' },
] as const;
const SCOPES = [
  { value: 'picks', label: 'Picks' },
  { value: 'everything', label: 'Everything' },
] as const;

/** Re-render on the minute, so "Up next" and "Today" move without a pull. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function CalendarScreen() {
  const p = usePalette();
  const cal = useCalendar();
  const now = useNow();
  const deviceTz = deviceTimeZone();
  const today = wallClock(deviceTz, now).date;

  const [view, setView] = useState<CalView>('upcoming');
  const [scope, setScope] = useState<Scope>('everything');
  const [kinds, setKinds] = useState<CalendarKind[]>([]);
  const [month, setMonth] = useState(() => ({
    year: Number(today.slice(0, 4)),
    month0: Number(today.slice(5, 7)) - 1,
  }));
  const [selected, setSelected] = useState<string | null>(today);

  const shown = useMemo(
    () => applyFilter(cal.entries, { scope, kinds }),
    [cal.entries, scope, kinds],
  );
  const next = useMemo(() => upNext(shown, now), [shown, now]);
  const toggleKind = (k: CalendarKind) =>
    setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const open = (id: string) => router.push({ pathname: '/entry/[id]', params: { id } });

  const header = (
    <View style={styles.header}>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Link href="/settings" style={[styles.headerButton, { color: p.accentText }]}>
              Connection
            </Link>
          ),
          headerRight: () => (
            <Link
              href={{
                pathname: '/entry/[id]',
                params: { id: 'new', date: view === 'month' && selected ? selected : today },
              }}
              style={[styles.headerButton, styles.plus, { color: p.accentText }]}
              accessibilityLabel="New entry"
            >
              +
            </Link>
          ),
        }}
      />
      {cal.ready && !cal.connection ? (
        <Link
          href="/settings"
          style={[styles.banner, { backgroundColor: p.raised, color: p.text }]}
        >
          Connect to your musterd daemon to load the calendar →
        </Link>
      ) : null}
      {next ? (
        <Pressable
          onPress={() => open(next.id)}
          style={[styles.upNext, { backgroundColor: p.surface, borderColor: p.accent }]}
        >
          <Text style={[styles.upNextLabel, { color: p.accentText }]}>UP NEXT</Text>
          <Text style={[styles.upNextTitle, { color: p.text }]} numberOfLines={2}>
            {next.title}
          </Text>
          <Text style={{ color: p.muted }}>
            {dayHeading(next.date, today)} · {timeLabel(next)}
            {next.place ? ` · ${next.place}` : ''}
          </Text>
        </Pressable>
      ) : null}
      <Segmented<CalView> options={VIEWS} value={view} onChange={setView} />
      <Segmented<Scope> options={SCOPES} value={scope} onChange={setScope} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
      >
        {CALENDAR_KINDS.map((k) => (
          <Chip
            key={k}
            label={k}
            color={KIND_COLORS[k]}
            on={kinds.includes(k)}
            onPress={() => toggleKind(k)}
          />
        ))}
      </ScrollView>
      <SyncLine
        report={cal.report}
        syncing={cal.syncing}
        lastSyncedAt={cal.lastSyncedAt}
        now={now.getTime()}
      />
    </View>
  );

  const refresh = (
    <RefreshControl
      refreshing={cal.syncing}
      onRefresh={() => void cal.refresh()}
      tintColor={p.accent}
    />
  );

  if (view === 'month') {
    const dayEntries = selected ? entriesOn(shown, selected) : [];
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={refresh}
        style={{ backgroundColor: p.bg }}
      >
        {header}
        <MonthView
          year={month.year}
          month0={month.month0}
          today={today}
          selected={selected}
          counts={countByDate(shown)}
          onSelect={setSelected}
          onShift={(d) => setMonth((m) => shiftMonth(m.year, m.month0, d))}
        />
        {selected ? (
          <Text style={[styles.sectionHead, { color: p.muted, backgroundColor: p.bg }]}>
            {dayHeading(selected, today)}
          </Text>
        ) : null}
        {dayEntries.map((e) => (
          <EntryRow
            key={e.id}
            entry={e}
            deviceTz={deviceTz}
            over={isOver(e, now)}
            onPress={() => open(e.id)}
          />
        ))}
        {selected && dayEntries.length === 0 ? (
          <Text style={[styles.empty, { color: p.muted }]}>Nothing on this day.</Text>
        ) : null}
      </ScrollView>
    );
  }

  const sections = (
    view === 'upcoming' ? upcomingSections(shown, today) : pastSections(shown, today)
  ).map((s) => ({
    title: dayHeading(s.date, today),
    data: s.entries,
  }));

  return (
    <SectionList
      style={{ backgroundColor: p.bg }}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={refresh}
      ListHeaderComponent={header}
      sections={sections}
      keyExtractor={(e) => e.id}
      stickySectionHeadersEnabled
      renderSectionHeader={({ section }) => (
        <Text style={[styles.sectionHead, { color: p.muted, backgroundColor: p.bg }]}>
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => (
        <EntryRow
          entry={item}
          deviceTz={deviceTz}
          over={view === 'upcoming' && isOver(item, now)}
          onPress={() => open(item.id)}
        />
      )}
      ListEmptyComponent={
        <Text style={[styles.empty, { color: p.muted }]}>
          {view === 'upcoming' ? 'Nothing coming up.' : 'Nothing in the past.'}
          {kinds.length > 0 || scope === 'picks'
            ? ' Try Everything, or clear the kind filter.'
            : ''}
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  header: { padding: space.lg, gap: space.md },
  headerButton: { fontSize: 16, fontWeight: '500' },
  plus: { fontSize: 28, fontWeight: '400', paddingHorizontal: space.xs },
  banner: { padding: space.md, borderRadius: radius.md, overflow: 'hidden' },
  upNext: { padding: space.lg, borderRadius: radius.md, borderLeftWidth: 4, gap: space.xs },
  upNextLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  upNextTitle: { fontSize: 18, fontWeight: '600' },
  chips: { gap: space.sm },
  sectionHead: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  empty: { padding: space.xl, textAlign: 'center' },
});
