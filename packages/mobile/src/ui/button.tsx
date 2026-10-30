import type { SFSymbol } from 'expo-symbols';
import { StyleSheet, Text } from 'react-native';
import { Icon } from './icon';
import { Squish } from './motion';
import { font, radius, space, usePalette } from './theme';

/**
 * The app's three buttons. `primary` is the one mustard action on a screen, `secondary` the
 * grey one beside it, `quiet` a text-only way out. Each is at least 44 points tall.
 */
export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  hint,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'quiet';
  icon?: SFSymbol;
  hint?: string;
}) {
  const p = usePalette();
  const fg = kind === 'primary' ? p.onAccent : kind === 'secondary' ? p.text : p.accentText;
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      onPress={onPress}
      style={[
        styles.base,
        kind === 'primary' && [styles.primary, { backgroundColor: p.accent }],
        kind === 'secondary' && [styles.secondary, { backgroundColor: p.raised }],
      ]}
    >
      {icon ? <Icon name={icon} color={fg} size={19} /> : null}
      <Text style={[kind === 'primary' ? styles.primaryText : styles.text, { color: fg }]}>
        {label}
      </Text>
    </Squish>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    gap: space.sm,
    minHeight: 44,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { minHeight: 52 },
  secondary: { minHeight: 48 },
  primaryText: { fontFamily: font.bold, fontSize: 17 },
  text: { fontFamily: font.semibold, fontSize: 17 },
});
