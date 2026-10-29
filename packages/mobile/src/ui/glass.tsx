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
 * The warm light behind the glass: two soft mustard and sand discs at the top of a screen, so
 * the glass has colour to bend. Decoration only, hidden from VoiceOver.
 */
export function Backdrop() {
  const p = usePalette();
  return (
    <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
      <View style={[styles.disc, styles.discA, { backgroundColor: p.tint }]} />
      <View style={[styles.disc, styles.discB, { backgroundColor: p.sand, opacity: 0.45 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  shape: { borderRadius: 22, overflow: 'hidden' },
  solid: {
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  disc: { position: 'absolute', borderRadius: 999 },
  discA: { width: 340, height: 340, top: -140, left: -90 },
  discB: { width: 280, height: 280, top: -60, right: -120 },
});
