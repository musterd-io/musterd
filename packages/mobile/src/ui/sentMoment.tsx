import { router } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Moment } from './moment';
import { AUTO_RETURN_MS, GLIDE, leaveTo } from './springs';
import { usePalette } from './theme';

/**
 * The answer-sent moment (nick, 2026-11-06): the check pops as before, a thin mustard bar drains
 * across AUTO_RETURN_MS, then the moment fades and you are back where you came from — Now, or the
 * ask list behind it. A tap anywhere leaves at once. Reduce Motion: no bar and no fade, and it still
 * returns on time. Only a sent answer leaves on its own; a failure keeps its buttons.
 */
export function SentMoment({ title, copy }: { title: string; copy: string }) {
  const p = usePalette();
  const reduce = useReducedMotion();
  const left = useRef(false);
  const fade = useSharedValue(1);
  const drain = useSharedValue(1);

  const go = useCallback(() => {
    if (left.current) return;
    left.current = true;
    if (leaveTo(router.canGoBack()) === 'back') router.back();
    else router.replace('/');
  }, []);

  const leave = useCallback(() => {
    if (left.current) return;
    if (reduce) {
      go();
      return;
    }
    fade.value = withTiming(0, { duration: GLIDE.duration }, (done) => {
      if (done) runOnJS(go)();
    });
  }, [fade, go, reduce]);

  useEffect(() => {
    if (!reduce) drain.value = withTiming(0, { duration: AUTO_RETURN_MS, easing: Easing.linear });
    const t = setTimeout(leave, AUTO_RETURN_MS);
    return () => clearTimeout(t);
  }, [drain, leave, reduce]);

  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const barStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: drain.value }] }));

  return (
    <Pressable
      style={StyleSheet.absoluteFill}
      onPress={leave}
      accessibilityRole="button"
      accessibilityLabel={`${title}. Tap to go back now.`}
    >
      <Animated.View style={[StyleSheet.absoluteFill, fadeStyle]}>
        <Moment icon="checkmark" tone="done" title={title} copy={copy}>
          {reduce ? null : (
            <View style={[styles.track, { backgroundColor: p.tint }]}>
              <Animated.View style={[styles.bar, { backgroundColor: p.accent }, barStyle]} />
            </View>
          )}
        </Moment>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  // scaleX drains toward the left edge: the bar is anchored there by its own width.
  bar: { height: 3, borderRadius: 2, width: '100%', transformOrigin: 'left' },
});
