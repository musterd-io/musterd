import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { usePalette } from './theme';

/**
 * A card of Liquid Glass (ADR 764) on iOS 26, over the app's warm `Backdrop`. Where the system
 * has no Liquid Glass it is the solid white card the app had before: same shape, a hairline
 * border and a soft shadow, so nothing reads differently but the material.
 */
export function Glass({
  children,
  style,
  tint,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tint?: string;
}) {
  const p = usePalette();
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="light"
        {...(tint ? { tintColor: tint } : {})}
        style={[styles.shape, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        styles.shape,
        styles.solid,
        { backgroundColor: p.surface, borderColor: p.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The warm light behind a whole screen: one soft mustard glow at the top corner, built from
 * stacked faint rings so it fades without a blur, and gives the glass colour to bend. It sits
 * behind the screen's content, never inside a scrolling header. Decoration only, hidden from
 * VoiceOver.
 */
export function Backdrop() {
  const p = usePalette();
  return (
    <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
      {GLOW.map((ring) => (
        <View
          key={ring.size}
          style={[
            styles.ring,
            {
              width: ring.size,
              height: ring.size,
              top: -ring.size / 2 + 40,
              left: -ring.size / 2 + 60,
              opacity: ring.opacity,
              backgroundColor: p.accent,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** Twelve rings, each a little smaller and stronger, so no edge reads on its own. */
const GLOW = Array.from({ length: 12 }, (_, i) => ({ size: 760 - i * 52, opacity: 0.012 }));

const styles = StyleSheet.create({
  shape: { borderRadius: 22, overflow: 'hidden' },
  solid: {
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  ring: { position: 'absolute', borderRadius: 999 },
});
