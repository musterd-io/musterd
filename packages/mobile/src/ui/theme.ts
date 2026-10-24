import { useColorScheme } from 'react-native';

/**
 * The app's palette, from brand.md §2: mustard `#E1AD01` is the one accent, zinc is the ground, and
 * the semantic colours are the brand's light/dark pairs. `sand` and `teal` are the mark's own tile
 * and letter (ADR 702) — used only where the app shows a member's seat, never as a second accent.
 * `tint` is mustard-50 (light) / a mustard wash on zinc (dark): the warm glow behind a moment.
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
  success: '#15803D',
  tint: '#FBF3D5',
  sand: '#EBD9A0',
  teal: '#1F6F6B',
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
  success: '#22C55E',
  tint: '#2A2412',
  sand: '#EBD9A0',
  teal: '#1F6F6B',
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;
