import type { Envelope, HuddleView } from '@musterd/protocol';
import { deriveHuddles } from '@musterd/protocol/wire';

/**
 * The huddle surface's web-side reading (ADR 378 increment 2).
 *
 * The fold itself is `deriveHuddles` in the protocol package — a huddle is a thread, so what a
 * huddle IS (which rows belong to it, who is in it, whether it is closed) is a reading of the wire
 * that every surface must answer identically. This module holds only what /live and /broadcast add
 * on top: which huddles are still open, who is actually gathered in one, and the budget AS DISPLAY.
 *
 * **The budget is a declaration, never a rule.** The daemon runs no clocks and neither does this
 * page (ADR 378 §4, ADR 131 §7): nothing here closes a huddle, hides one, or greys it out for going
 * over. An over-budget huddle stays open, stays visible, and says so — that is the honest surface of
 * a team that said six turns and took nine.
 */
export interface HuddleBudgetView {
  /** Rows on the thread so far — the count readers do themselves, because nothing stores it. */
  turnsUsed: number;
  turnsDeclared?: number;
  /** Declared minus used; negative once the huddle has run past what it said. */
  turnsLeft?: number;
  overTurns: boolean;
  /** Declared end minus the clock passed in; negative once that moment is behind us. */
  msLeft?: number;
  overTime: boolean;
  /** `none` — nothing declared. `within` — inside what was declared. `spent` — past it, still open. */
  phase: 'none' | 'within' | 'spent';
}

/** Still going: a root whose thread carries no `resolve`. */
export function openHuddles(views: HuddleView[]): HuddleView[] {
  return views.filter((v) => !v.closed);
}

/**
 * Who is in the room right now — the opener and everyone who has taken a turn in a huddle that is
 * still open. Being NAMED at the root is an invitation, not attendance: a seat that never spoke is
 * not gathered, and the office must not draw it at the table as if it were.
 */
export function gatheredSeats(views: HuddleView[]): Set<string> {
  const seats = new Set<string>();
  for (const v of openHuddles(views)) for (const name of v.spoke) seats.add(name);
  return seats;
}

/**
 * The budget as it reads at `now`. Clock-dependent by construction, so it lives OUTSIDE the
 * derivation's memo — the same seam `askPhase` took (#1158): the fold is pure over the timeline and
 * re-runs only when the timeline changes; the clock re-reads on the tick.
 */
export function huddleBudget(view: HuddleView, now: number): HuddleBudgetView {
  const turnsUsed = view.turns.length;
  const declared = view.budget;
  if (!declared || (declared.turns === undefined && declared.until === undefined)) {
    return { turnsUsed, overTurns: false, overTime: false, phase: 'none' };
  }
  const turnsLeft = declared.turns === undefined ? undefined : declared.turns - turnsUsed;
  const msLeft = declared.until === undefined ? undefined : declared.until - now;
  const overTurns = turnsLeft !== undefined && turnsLeft < 0;
  const overTime = msLeft !== undefined && msLeft < 0;
  return {
    turnsUsed,
    ...(declared.turns === undefined ? {} : { turnsDeclared: declared.turns }),
    ...(turnsLeft === undefined ? {} : { turnsLeft }),
    overTurns,
    ...(msLeft === undefined ? {} : { msLeft }),
    overTime,
    phase: overTurns || overTime ? 'spent' : 'within',
  };
}

/**
 * The gathering, straight off the timeline the page already holds (backfill + the `team-all`
 * firehose, ADR 061). No endpoint, no roster, no room state — the same substrate the asks rail folds.
 * `me` is irrelevant to who is in the room, so the fold is asked for as nobody.
 */
export function gatheredFrom(envelopes: Envelope[]): Set<string> {
  return gatheredSeats(deriveHuddles(envelopes, ''));
}

/**
 * Where the Stream draws each huddle as ONE card (huddle replay increment 1, nick 2026-10-01).
 *
 * A huddle's turns land between everyone else's traffic, so read row by row the room is scattered
 * across the panel. The Stream instead folds the root and every row on its thread into a single
 * card, and puts that card where the huddle's LATEST row sits: each new turn moves it to the live
 * edge, and a resolve pins it where the room closed. Only the Stream reads this — the office floor
 * keeps drawing every act as its own bubble, huddle or not.
 *
 * - `cardAt` — the id of the row a card replaces → that huddle's view.
 * - `folded` — every row id a card owns, its anchor included; the Stream skips them as plain rows.
 */
export function streamPlacement(envelopes: Envelope[]): {
  cardAt: Map<string, HuddleView>;
  folded: Set<string>;
} {
  const views = deriveHuddles(envelopes, '');
  const byRoot = new Map(views.map((v) => [v.id, v]));
  const last = new Map<string, string>();
  const folded = new Set<string>();
  for (const e of envelopes) {
    const rootId = byRoot.has(e.id) ? e.id : e.thread && byRoot.has(e.thread) ? e.thread : null;
    if (!rootId) continue;
    folded.add(e.id);
    last.set(rootId, e.id); // the timeline is oldest-first, so the final write is the latest row
  }
  const cardAt = new Map<string, HuddleView>();
  for (const [rootId, anchor] of last) cardAt.set(anchor, byRoot.get(rootId)!);
  return { cardAt, folded };
}

/** Time from the open to a turn, in the close-note format (`miley +1.4m`): s, tenths of a minute, h+mm. */
export function sinceOpen(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `+${s}s`;
  if (s < 3600) return `+${(s / 60).toFixed(1).replace(/\.0$/, '')}m`;
  const m = Math.floor(s / 60);
  return `+${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
