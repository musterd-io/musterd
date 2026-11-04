import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Backdrop, Glass } from './glass';
import { Icon } from './icon';
import { Breathe, Pop, Rise } from './motion';
import { font, radius, space, usePalette } from './theme';

/**
 * A screen given to one moment: something on its way, done, or stopped. Not a hero (nick,
 * 2026-11-03: "No big text, heros, headers"): one glass card near the top, a symbol in a small
 * tile (or the breathing dots while it waits), a short title, a line under it, and the buttons.
 * `tone` colours the tile: `done` is mustard, `stop` is the quiet grey of a dead end.
 */
export function Moment({
  icon,
  tone = 'stop',
  title,
  copy,
  children,
}: {
  icon?: SFSymbol;
  tone?: 'done' | 'stop';
  title: string;
  copy?: string;
  children?: ReactNode;
}) {
  const p = usePalette();
  const done = tone === 'done';
  return (
    <View style={[styles.screen, { backgroundColor: p.bg }]}>
      <Backdrop />
      <Pop style={styles.wrap}>
        <Glass style={styles.card}>
          <View style={styles.row}>
            {icon ? (
              <View style={[styles.tile, { backgroundColor: done ? p.accent : p.raised }]}>
                <Icon name={icon} color={done ? p.onAccent : p.muted} size={20} bounce={done} />
              </View>
            ) : (
              <View style={[styles.tile, styles.dots, { backgroundColor: p.tint }]}>
                {[0, 1, 2].map((i) => (
                  <Breathe key={i} delay={i * 220}>
                    <View style={[styles.dot, { backgroundColor: p.accent }]} />
                  </Breathe>
                ))}
              </View>
            )}
            <View style={styles.words}>
              <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
                {title}
              </Text>
              {copy ? <Text style={[styles.copy, { color: p.muted }]}>{copy}</Text> : null}
            </View>
          </View>
          {children ? (
            <Rise index={1} style={styles.actions}>
              {children}
            </Rise>
          ) : null}
        </Glass>
      </Pop>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: space.lg, paddingTop: space.xl * 3 },
  wrap: { alignSelf: 'stretch' },
  card: { padding: space.lg, gap: space.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: { flexDirection: 'row', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: radius.pill },
  words: { flex: 1, gap: 2 },
  title: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22 },
  copy: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  actions: { gap: space.sm },
});
