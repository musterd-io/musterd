import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs/types';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useChrome } from './chrome';
import { Glass } from './glass';
import { tap } from './haptics';
import { pillBottom, SPRING, TAB_BOUNCE, tabTint, type Tab } from './springs';
import { TabIcon } from './tabIcons';
import { font, usePalette } from './theme';

/**
 * The shell's floating tab pill (ADR 814 decision 5, ADR 815): one piece of warm glass centred
 * above the home indicator, never a full-width bar, after movetrail's `CustomTabBar`. Each tab is
 * its glyph over a small label and keeps its own tint when idle; the active one sits in a soft
 * mustard gradient capsule with a thin mustard border. A press ticks (haptic), bounces the glyph
 * down-over-rest on the UI thread, and warms the label. The pill slides away as a list scrolls
 * down and returns on a scroll up or a tab press (`chrome.tsx`). Reduce Motion: no bounce, no
 * slide — the capsule simply moves.
 */
export function TabBar({ state, descriptors, emitter, navigateToTab }: BottomTabBarProps) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { visible, reveal } = useChrome();
  const bottom = Platform.OS === 'ios' ? pillBottom(insets.bottom) : 6;
  const barStyle = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: interpolate(visible.value, [0, 1], [10, 0], Extrapolation.CLAMP) }],
  }));
  return (
    <Animated.View pointerEvents="box-none" style={[styles.wrap, { bottom }, barStyle]}>
      <Glass tint={GLASS_TINT} style={[styles.bar, { borderColor: BORDER }]}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key]?.options;
          const label = typeof options?.title === 'string' ? options.title : route.name;
          const tab = route.name as Tab;
          const badge = options?.tabBarBadge;
          const onPress = () => {
            tap();
            reveal();
            // expo-router 58's bundled tabs hand the bar an emitter and navigateToTab, not a
            // navigation prop; the stock bar emits the same event before it moves.
            const event = emitter.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigateToTab(route.key);
          };
          return (
            <TabButton
              key={route.key}
              tab={tab}
              label={label}
              tint={focused ? p.accentText : tabTint(tab, p)}
              focused={focused}
              badge={badge}
              onPress={onPress}
            />
          );
        })}
      </Glass>
    </Animated.View>
  );
}

function TabButton({
  tab,
  label,
  tint,
  focused,
  badge,
  onPress,
}: {
  tab: Tab;
  label: string;
  tint: string;
  focused: boolean;
  badge: number | string | undefined;
  onPress: () => void;
}) {
  const p = usePalette();
  const reduce = useReducedMotion();
  const scale = useSharedValue(1);
  const progress = useSharedValue(focused ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(focused ? 1 : 0, { duration: reduce ? 0 : 200 });
    if (focused && !reduce)
      scale.value = withSequence(
        withSpring(TAB_BOUNCE[0], SPRING.press),
        withSpring(TAB_BOUNCE[1], { damping: 9, stiffness: 320 }),
        withSpring(TAB_BOUNCE[2], SPRING.settle),
      );
  }, [focused, progress, reduce, scale]);
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], [p.muted, p.accentText]),
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={focused ? { selected: true } : {}}
      onPress={onPress}
      style={[styles.tab, focused && styles.tabActive]}
    >
      {focused ? <Capsule /> : null}
      <Animated.View style={iconStyle}>
        <TabIcon tab={tab} color={tint} active={focused} />
      </Animated.View>
      <Animated.Text style={[styles.label, labelStyle]} numberOfLines={1}>
        {label}
      </Animated.Text>
      {badge !== undefined && badge !== 0 ? (
        <View style={[styles.badge, { backgroundColor: p.danger }]} accessibilityElementsHidden>
          <Text style={styles.badgeText}>{String(badge)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** The active tab's warm capsule: a vertical mustard-50 gradient under a thin mustard border. */
function Capsule() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" accessible={false}>
      <Defs>
        <LinearGradient id="capsule" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFF6DB" />
          <Stop offset="1" stopColor="#FBE7A8" />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" rx={16} fill="url(#capsule)" />
    </Svg>
  );
}

/** A breath of warmth in the glass: the page's cream, not a grey system bar. */
const GLASS_TINT = 'rgba(253, 249, 241, 0.82)';
const BORDER = 'rgba(231, 223, 216, 0.55)';

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 52,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderRadius: 26,
    shadowColor: '#6B3D0A',
    shadowOpacity: 0.18,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  tab: {
    minWidth: 62,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    paddingHorizontal: 10,
    borderRadius: 16,
    overflow: 'hidden',
  },
  tabActive: { borderWidth: 1, borderColor: 'rgba(225, 173, 1, 0.35)' },
  label: { fontFamily: font.semibold, fontSize: 9.5 },
  badge: {
    position: 'absolute',
    top: 3,
    right: 10,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontFamily: font.bold, fontSize: 8.5 },
});
