import { Image, StyleSheet, Text, View } from 'react-native';
import mark from '../../assets/mark.png';
import { headerLines, type TeamRows } from '../native/team';
import { Breathe, Squish } from './motion';
import { font, radius, space, usePalette } from './theme';

const MARK = 36;

/**
 * Now's top line (nick, 2026-11-06: "not aligned and looks very bare … needs a musterd polish"):
 * one row on a single centre line — the musterd mark with this phone's state dot on its corner, the
 * team's name over who is here and away, and, when something waits on you, a mustard chip that
 * jumps to it.
 */
export function NowHeader({
  pairing,
  team,
  counts,
  onPressChip,
}: {
  pairing: 'paired' | 'waiting' | 'none';
  team: string | null;
  counts: TeamRows['counts'];
  onPressChip?: () => void;
}) {
  const p = usePalette();
  const lines = headerLines({ pairing, team, counts });
  const dot = { paired: p.success, waiting: p.accent, none: p.placeholder }[pairing];
  return (
    <View style={styles.row}>
      <View accessible accessibilityLabel={`${lines.title}, ${lines.sub}`} style={styles.identity}>
        <View>
          <Image source={mark} style={styles.mark} accessibilityIgnoresInvertColors />
          <View style={[styles.dotRing, { backgroundColor: p.bg }]}>
            <Breathe>
              <View style={[styles.dot, { backgroundColor: dot }]} />
            </Breathe>
          </View>
        </View>
        <View style={styles.words}>
          <Text numberOfLines={1} style={[styles.title, { color: p.text }]}>
            {lines.title}
          </Text>
          <Text numberOfLines={1} style={[styles.sub, { color: p.muted }]}>
            {lines.sub}
          </Text>
        </View>
      </View>
      {lines.chip ? (
        <Squish
          accessibilityRole="button"
          accessibilityLabel={lines.chip}
          onPress={() => onPressChip?.()}
          style={[styles.chip, { backgroundColor: p.accent }]}
        >
          <Text style={[styles.chipText, { color: p.onAccent }]}>{lines.chip}</Text>
        </Squish>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: 48,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, flexShrink: 1 },
  mark: { width: MARK, height: MARK, borderRadius: 10 },
  dotRing: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  words: { flexShrink: 1, gap: 0 },
  title: { fontFamily: font.display, fontSize: 21, lineHeight: 25, letterSpacing: -0.3 },
  sub: { fontFamily: font.medium, fontSize: 12.5, lineHeight: 16 },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    minHeight: 32,
    justifyContent: 'center',
  },
  chipText: { fontFamily: font.bold, fontSize: 13 },
});
