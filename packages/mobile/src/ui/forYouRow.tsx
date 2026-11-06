import { StyleSheet, Text, View } from 'react-native';
import type { AppForYou } from '../native/team';
import { Squish } from './motion';
import { ago, Seat } from './seat';
import { font, radius, space, usePalette } from './theme';

/**
 * One thing waiting on you (ADR 814 decision 3): the asker's letter, the question in one line,
 * "asker · kind · ago" under it, and a mustard chip — Answer for a question, Review for the rest.
 * Tapping the row opens the ask.
 */
export function ForYouRow({
  item,
  now,
  onPress,
}: {
  item: AppForYou;
  now: number;
  onPress: () => void;
}) {
  const p = usePalette();
  const chip = item.kind === 'question' ? 'Answer' : 'Review';
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${chip}: ${item.summary}, from ${item.from}`}
      onPress={onPress}
      style={styles.row}
    >
      <Seat name={item.from} agent size={26} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.summary, { color: p.text }]}>
          {item.summary}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: p.muted }]}>
          {`${item.from} · ${item.kind} · ${ago(item.ts, now)}`}
        </Text>
      </View>
      <View style={[styles.chip, { backgroundColor: p.tint }]}>
        <Text style={[styles.chipText, { color: p.accentText }]}>{chip}</Text>
      </View>
    </Squish>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, paddingVertical: 6 },
  text: { flex: 1, minWidth: 0, gap: 1 },
  summary: { fontFamily: font.semibold, fontSize: 12.5 },
  meta: { fontFamily: font.regular, fontSize: 11 },
  chip: { borderRadius: radius.sm + 2, paddingHorizontal: 9, paddingVertical: 4 },
  chipText: { fontFamily: font.bold, fontSize: 11 },
});
