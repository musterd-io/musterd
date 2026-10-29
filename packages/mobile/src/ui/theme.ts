/**
 * The app's palette, from brand.md §2: mustard `#E1AD01` is the one accent, zinc is the ground, and
 * the semantic colours are the brand's light values. The app is light only (`userInterfaceStyle`
 * in app.json, nick 2026-10-29): it does not follow the phone's dark mode. `sand` and `teal` are
 * the mark's own tile and letter (ADR 702) — used only where the app shows a member's seat, never
 * as a second accent.
 * `tint` is mustard-50: the warm glow behind a moment.
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

export type Palette = typeof light;

export function usePalette(): Palette {
  return light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;

/**
 * DM Sans for every word, data included (brand.md §3; nick 2026-10-22, #3194: "everything in our
 * new font family"); figures that must line up use `fontVariant: ['tabular-nums']`. Each weight is
 * its own static file embedded by the expo-font plugin (ADR 760), so a style names the file, not
 * a `fontWeight` (iOS would fake a bold over one face).
 */
export const font = {
  regular: 'DMSans-Regular',
  medium: 'DMSans-Medium',
  semibold: 'DMSans-SemiBold',
  bold: 'DMSans-Bold',
  display: 'DMSans-ExtraBold',
} as const;
