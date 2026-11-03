import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Glass } from './glass';
import { Icon } from './icon';
import { font, radius, space, usePalette } from './theme';

/**
 * A short note on a screen (phone polish pass, lane 01M6HQ4DT4): a symbol in a small tinted tile,
 * a one-line title and at most a line or two under it, on glass. It replaces the plain grey text
 * blocks the screens used for every status, so a note reads as part of the app, not as raw text.
 * `warm` is mustard (something of yours is in flight), `quiet` is zinc (a fact), `alert` is red.
 */
export function Notice({
  icon,
  title,
  body,
  tone = 'quiet',
  children,
}: {
  icon: SFSymbol;
  title: string;
  body?: string;
  tone?: 'warm' | 'quiet' | 'alert';
  children?: ReactNode;
}) {
  const p = usePalette();
  const [tile, ink] =
    tone === 'warm'
      ? [p.tint, p.accentText]
      : tone === 'alert'
        ? ['#FDECEC', p.danger]
        : [p.raised, p.text];
  return (
    <Glass style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.tile, { backgroundColor: tile }]}>
          <Icon name={icon} color={ink} size={15} />
        </View>
        <View style={styles.words}>
          <Text style={[styles.title, { color: p.text }]}>{title}</Text>
          {body ? <Text style={[styles.body, { color: p.muted }]}>{body}</Text> : null}
        </View>
      </View>
      {children}
    </Glass>
  );
}

/** A small label over a group of cards, with an optional count in a pill beside it. */
export function SectionLabel({ label, count }: { label: string; count?: number | string }) {
  const p = usePalette();
  return (
    <View style={styles.section} accessibilityRole="header">
      <Text style={[styles.sectionText, { color: p.muted }]}>{label}</Text>
      {count !== undefined ? (
        <View style={[styles.count, { backgroundColor: p.tint }]}>
          <Text style={[styles.countText, { color: p.accentText }]}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: space.md, gap: space.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  tile: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  words: { flex: 1, gap: 2, paddingTop: 1 },
  title: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  body: { fontFamily: font.regular, fontSize: 14, lineHeight: 19 },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xs,
  },
  sectionText: { fontFamily: font.semibold, fontSize: 13, letterSpacing: 0.2 },
  count: {
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontFamily: font.bold, fontSize: 12, fontVariant: ['tabular-nums'] },
});
