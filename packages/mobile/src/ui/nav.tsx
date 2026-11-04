import type { NativeStackHeaderProps } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import wordmark from '../../assets/wordmark.png';
import { Glass } from './glass';
import { Icon } from './icon';
import { Rise, Squish } from './motion';
import { font, space, usePalette } from './theme';

/**
 * How tall the bar is below the status bar. A screen under it pads its scroll content by this much
 * (and its pull-to-refresh spinner with `progressViewOffset`): the bar floats over the screen's
 * warm glow, so nothing on the screen moves it down for them.
 */
export const NAV_HEIGHT = 48;

/**
 * The app's own navigation bar, in place of the stock iOS one (nick, 2026-11-04: the "< Asks" bar
 * "looks extremely generic and huge"). It is two small floating pieces of glass over the screen's
 * glow, never a band: a round back button with only a chevron, and the screen's name in a capsule
 * beside a mustard roll-call dot. Home has no back, so the nameplate wordmark heads it instead.
 * The edge-swipe back gesture is the navigator's and still works. Both pieces rise in.
 */
export function NavBar({ back, navigation, options, route }: NativeStackHeaderProps) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const title = typeof options.title === 'string' ? options.title : route.name;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.bar, { paddingTop: insets.top, height: insets.top + NAV_HEIGHT }]}
    >
      {back ? (
        <>
          <Rise style={styles.left}>
            <Squish
              accessibilityRole="button"
              accessibilityLabel={back.title ? `Back to ${back.title}` : 'Back'}
              hitSlop={8}
              onPress={() => navigation.goBack()}
            >
              <Glass tint={GLASS_TINT} style={styles.backButton}>
                <Icon name="chevron.left" color={p.accentText} size={16} fallback="‹" />
              </Glass>
            </Squish>
          </Rise>
          <Rise index={1} style={styles.center}>
            <Glass tint={GLASS_TINT} style={styles.titleChip}>
              <View style={[styles.dot, { backgroundColor: p.accent }]} />
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
                style={[styles.title, { color: p.text }]}
              >
                {title}
              </Text>
            </Glass>
          </Rise>
        </>
      ) : (
        <Rise style={styles.center}>
          <Image
            source={wordmark}
            style={styles.wordmark}
            accessibilityRole="header"
            accessibilityLabel="musterd"
          />
        </Rise>
      )}
    </View>
  );
}

/** A breath of mustard in the glass, so the pieces read warm, not grey. */
const GLASS_TINT = 'rgba(225, 173, 1, 0.07)';

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  left: { position: 'absolute', left: space.lg, bottom: (NAV_HEIGHT - 36) / 2 },
  center: { alignItems: 'center', justifyContent: 'center' },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 32,
    borderRadius: 16,
    paddingHorizontal: space.md,
    maxWidth: 220,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  title: { fontFamily: font.semibold, fontSize: 15, letterSpacing: -0.1 },
  wordmark: { width: 110, height: 27 },
});
