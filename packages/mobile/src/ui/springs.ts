import type { Palette } from './theme';

/**
 * The app shell's motion constants (ADR 815, the app shell design's feel bar). Three springs and
 * one bounce, named for what they do so a screen never invents its own numbers: `press` is the
 * squash under a finger, `settle` is a thing coming to rest (a row sliding into its new place, an
 * icon after its bounce), `sheet` is the member sheet rising or being let go. All three come to
 * rest inside the brand's 120–400 ms band at the sizes the shell moves.
 */
export const SPRING = {
  press: { damping: 14, stiffness: 600 },
  settle: { damping: 12, stiffness: 280 },
  sheet: { damping: 18, stiffness: 220 },
} as const;

/**
 * A row moving to its new place when the roster re-sorts: a glide that eases out and stops, never a
 * spring that overshoots (nick, build 61: "the bounces to member rows back into place is a little
 * too much — i like the idea but a little too much movement"). One of the brand's durations.
 */
export const GLIDE = { duration: 280 } as const;

/** The pressed tab's icon: down, over, and back to rest — movetrail's sequence. */
export const TAB_BOUNCE = [0.8, 1.15, 1] as const;

export type Tab = 'now' | 'work' | 'you';

/**
 * The tab a route name is. Now is `(tabs)/index.tsx`, because it must serve "/" — the URL the app
 * opens at (build 58 opened on "Unmatched Route" when it was `now.tsx`, which serves /now).
 */
export function tabOf(routeName: string): Tab {
  return routeName === 'index'
    ? 'now'
    : routeName === 'work' || routeName === 'you'
      ? routeName
      : 'now';
}

/**
 * Each tab keeps its own hue even when it is not the active one: mustard for Now (what needs you),
 * agent jade for Work, human rose for You — the brand's two identity colours, so the pill reads as
 * musterd and not as a grey system bar.
 */
export function tabTint(tab: Tab, p: Palette): string {
  switch (tab) {
    case 'now':
      return p.accent;
    case 'work':
      return '#1a9e88';
    case 'you':
      return '#d9557d';
  }
}

/** Where the pill floats above the home indicator: tucked into the inset, never under 2 pt. */
export function pillBottom(insetBottom: number): number {
  return Math.max(insetBottom - 16, 2);
}

/**
 * How long a sent answer's moment stays before it fades and returns you (nick, 2026-11-06: "an
 * overlay that magically fades away after say 5 seconds so you naturally return").
 */
export const AUTO_RETURN_MS = 5_000;

/** Where a finished moment returns to: back where you came from, or Now when nothing is behind. */
export function leaveTo(canGoBack: boolean): 'back' | 'home' {
  return canGoBack ? 'back' : 'home';
}

/**
 * One landing's glow at its member's desk (ADR 819): /live's "soft ding and a little glow", one at
 * a time. A burst queues; nothing glows at once with another.
 */
export const GLOW_MS = 1_200;
