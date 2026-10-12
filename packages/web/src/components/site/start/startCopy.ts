/**
 * /start's head strings, in a module of their own.
 *
 * Same measured split as `watchCopy.ts`: the route's `head:` needs the title, description and
 * alt text, and importing them from `StartPage.tsx` would pull the whole component module (and
 * its CSS) into the route's EAGER graph. A `head:` runs on every route in the tree, so what it
 * touches is a budget decision (ADR 151).
 *
 * Written in the private preview; since ADR 568 (2026-10-12) the preview is over and the home
 * page's Getting started carries the install. No state word ("live", "now", "currently") —
 * watch-page-copy-spec §2 governs prerendered HTML. No contrast frame (brand.md §4), no
 * "coordination layer" in the heading or opening sentence (homepage-copy-spec §0.2).
 */
export const START_COPY = {
  title: 'See your first ten minutes',
  description:
    'What the first ten minutes on musterd look like: give your agent a small piece of work, judge what comes back, and read the chain the team keeps.',
  h1: 'See your first ten minutes',
  /** Durable, not a state word. Was "Private preview" until ADR 568. */
  eyebrow: 'musterd · start',
} as const;
