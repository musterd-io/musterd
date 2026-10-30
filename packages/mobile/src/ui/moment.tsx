import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Backdrop } from './glass';
import { Icon } from './icon';
import { Breathe, Pop, Rise } from './motion';
import { font, radius, space, usePalette } from './theme';

/**
 * A whole screen given to one moment: something on its way, done, or stopped. A symbol in a
 * round badge (or the breathing dots while it waits), a short title, one line under it, and the
 * buttons. `tone` colours the badge: `done` is mustard, `stop` is the quiet grey of a dead end.
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
      {icon ? (
        <Pop style={[styles.badge, { backgroundColor: done ? p.accent : p.raised }]}>
          <Icon name={icon} color={done ? p.onAccent : p.muted} size={30} bounce={done} />
        </Pop>
      ) : (
        <View style={styles.dots}>
          {[0, 1, 2].map((i) => (
            <Breathe key={i} delay={i * 220}>
              <View style={[styles.dot, { backgroundColor: p.accent }]} />
            </Breathe>
          ))}
        </View>
      )}
      <Rise index={1}>
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
          {title}
        </Text>
      </Rise>
      {copy ? (
        <Rise index={2}>
          <Text style={[styles.copy, { color: p.muted }]}>{copy}</Text>
        </Rise>
      ) : null}
      {children ? (
        <Rise index={3} style={styles.actions}>
          {children}
        </Rise>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  dots: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  title: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.4, textAlign: 'center' },
  copy: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
  },
  actions: { alignSelf: 'stretch', gap: space.sm, marginTop: space.md },
});
