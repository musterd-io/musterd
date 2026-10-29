import { SymbolView, type SFSymbol } from 'expo-symbols';
import { Text } from 'react-native';

/**
 * An SF Symbol (ADR 764), in the colour and size of the text beside it. `fallback` is the glyph
 * shown where symbols are missing (Expo Go on another platform, a symbol an older iOS lacks).
 */
export function Icon({
  name,
  color,
  size = 17,
  fallback = '',
  bounce = false,
}: {
  name: SFSymbol;
  color: string;
  size?: number;
  fallback?: string;
  bounce?: boolean;
}) {
  return (
    <SymbolView
      name={name}
      tintColor={color}
      size={size}
      weight="semibold"
      {...(bounce ? { animationSpec: { effect: { type: 'bounce' } } } : {})}
      fallback={<Text style={{ color, fontSize: size }}>{fallback}</Text>}
      accessible={false}
    />
  );
}
