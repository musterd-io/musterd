import { Pressable, StyleSheet, Text, View } from 'react-native';
import { monthGrid, monthTitle } from '../lib/views';
import { radius, space, usePalette } from './theme';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** A Sunday-first month with a dot under each day that has entries; tapping a day selects it. */
export function MonthView(props: {
  year: number;
  month0: number;
  today: string;
  selected: string | null;
  counts: Map<string, number>;
  onSelect(date: string): void;
  onShift(delta: number): void;
}) {
  const p = usePalette();
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Pressable
          onPress={() => props.onShift(-1)}
          hitSlop={12}
          accessibilityLabel="Previous month"
        >
          <Text style={[styles.nav, { color: p.accentText }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: p.text }]}>
          {monthTitle(props.year, props.month0)}
        </Text>
        <Pressable onPress={() => props.onShift(1)} hitSlop={12} accessibilityLabel="Next month">
          <Text style={[styles.nav, { color: p.accentText }]}>›</Text>
        </Pressable>
      </View>
      <View style={styles.week}>
        {DAYS.map((d, i) => (
          <Text key={i} style={[styles.dayName, { color: p.muted }]}>
            {d}
          </Text>
        ))}
      </View>
      {monthGrid(props.year, props.month0).map((week, wi) => (
        <View key={wi} style={styles.week}>
          {week.map((date, di) => {
            if (date === null) return <View key={di} style={styles.cell} />;
            const count = props.counts.get(date) ?? 0;
            const isToday = date === props.today;
            const isSel = date === props.selected;
            return (
              <Pressable
                key={di}
                style={[styles.cell, isSel && { backgroundColor: p.raised }]}
                onPress={() => props.onSelect(date)}
                accessibilityLabel={`${date}, ${count} ${count === 1 ? 'entry' : 'entries'}`}
              >
                <View style={[styles.num, isToday && { backgroundColor: p.accent }]}>
                  <Text
                    style={{
                      color: isToday ? p.onAccent : p.text,
                      fontWeight: isToday ? '700' : '400',
                    }}
                  >
                    {Number(date.slice(8))}
                  </Text>
                </View>
                <View
                  style={[
                    styles.mark,
                    { backgroundColor: count > 0 ? p.accentText : 'transparent' },
                  ]}
                />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, gap: space.xs },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
  },
  title: { fontSize: 17, fontWeight: '600' },
  nav: { fontSize: 28, paddingHorizontal: space.sm },
  week: { flexDirection: 'row' },
  dayName: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600' },
  cell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    minHeight: 48,
  },
  num: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 5, height: 5, borderRadius: 2.5, marginTop: 3 },
});
