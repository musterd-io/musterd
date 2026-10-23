import { useColorScheme } from 'react-native';

/**
 * The app's palette, from brand.md §2: mustard `#E1AD01` is the one accent, zinc is the ground, and
 * the semantic colours are the brand's light/dark pairs.
 */
const light = {
  bg: '#FAFAFA',
  surface: '#FFFFFF',
  raised: '#F4F4F5',
  border: '#E4E4E7',
  text: '#18181B',
  muted: '#71717A',
  /** Hint text in an empty field — dimmer than typed text so a hint never reads as a value. */
  placeholder: '#A1A1AA',
  accent: '#E1AD01',
  accentText: '#7A5A06',
  onAccent: '#18181B',
  danger: '#B91C1C',
  warning: '#B45309',
};

const dark: typeof light = {
  bg: '#09090B',
  surface: '#18181B',
  raised: '#27272A',
  border: '#3F3F46',
  text: '#FAFAFA',
  muted: '#A1A1AA',
  placeholder: '#71717A',
  accent: '#E1AD01',
  accentText: '#EFC94C',
  onAccent: '#18181B',
  danger: '#EF4444',
  warning: '#F59E0B',
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, pill: 999 } as const;
