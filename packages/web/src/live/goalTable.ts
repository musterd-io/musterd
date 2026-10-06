import type { Goal, GoalFlow, Lane, LaneWarning } from '@musterd/protocol';
import { isAwaitingAcceptance } from '@musterd/protocol/wire';
import { buildGoalGrid } from './goalGrid';

/**
 * The board's table view (board readability inc 2): the questions nick asked a seat on 2026-10-05,
 * answered as one row per goal — who owns the live lanes, what is unowned, what it waits on, what
 * went quiet, and who owns the last thing that moved.
 *
 * Rows come from {@link buildGoalGrid}'s cards, so the table and the grid can never disagree about
 * which goals exist, their order, or where a retracted goal's lanes went. Pure; no DOM.
 */

/** A live lane untouched this long has gone quiet — the board's answer to "what got lost". */
export const QUIET_MS = 14 * 86_400_000;

export interface GoalRow {
  /** null = the goal-less pool. */
  id: string | null;
  title: string;
  /** The title up to its first " — ", the short name a one-line row can carry; `title` rides in the tooltip. */
  name: string;
  /** One line under the name: the goal's story, else the rest of its title after the dash, else null. */
  blurb: string | null;
  chip: string;
  /** Live lanes by stage, for the row's stacked bar. */
  mix: { open: number; working: number; blocked: number; review: number };
  /** Lanes still in play: not done, abandoned or parked. */
  live: number;
  /** Seats owning live lanes, most first (ties by name). */
  owners: Array<{ seat: string; n: number }>;
  unowned: number;
  blocked: number;
  /** Lanes awaiting acceptance, and the seats holding their asks (ADR 518), once each. */
  review: number;
  reviewers: string[];
  /** Live lanes not updated within {@link QUIET_MS}. */
  quiet: number;
  /** The most recently updated live lane, and its owner. */
  lastMoved: { lane: string; title: string; owner: string | null; at: number } | null;
}

function isLive(l: Lane): boolean {
  return l.state !== 'done' && l.state !== 'abandoned' && l.state !== 'parked';
}

export function buildGoalTable(
  lanes: Lane[],
  goals: Goal[],
  now: number,
  warnings: LaneWarning[] = [],
  goalFlow: GoalFlow[] = [],
): GoalRow[] {
  const byGoal = new Map<string | null, Lane[]>();
  for (const l of lanes) {
    if (!isLive(l)) continue;
    const key = l.goal_id ?? null;
    const list = byGoal.get(key);
    if (list) list.push(l);
    else byGoal.set(key, [l]);
  }
  const goalById = new Map(goals.map((g) => [g.id, g]));
  return buildGoalGrid(lanes, goals, now, warnings, goalFlow).cards.map((card) => {
    const [name, ...rest] = card.title.split(' — ');
    const live = byGoal.get(card.id) ?? [];
    const owned = new Map<string, number>();
    for (const l of live) if (l.owner_seat) owned.set(l.owner_seat, (owned.get(l.owner_seat) ?? 0) + 1);
    const awaiting = live.filter((l) => isAwaitingAcceptance(l.state));
    const last = live.reduce<Lane | null>(
      (best, l) => (best === null || l.updated_at > best.updated_at ? l : best),
      null,
    );
    return {
      id: card.id,
      title: card.title,
      name: name!.trim(),
      blurb:
        (card.id !== null ? goalById.get(card.id)?.story : undefined) ??
        (rest.length > 0 ? rest.join(' — ').trim() : null),
      chip: card.chip,
      mix: {
        open: live.filter((l) => l.state === 'open').length,
        working: live.filter((l) => l.state === 'claimed' || l.state === 'active').length,
        blocked: live.filter((l) => l.state === 'blocked').length,
        review: awaiting.length,
      },
      live: live.length,
      owners: [...owned]
        .map(([seat, n]) => ({ seat, n }))
        .sort((a, b) => b.n - a.n || a.seat.localeCompare(b.seat)),
      unowned: live.filter((l) => !l.owner_seat).length,
      blocked: live.filter((l) => l.state === 'blocked').length,
      review: awaiting.length,
      reviewers: [
        ...new Set(awaiting.flatMap((l) => (l.acceptance_reviewer ? [l.acceptance_reviewer] : []))),
      ].sort(),
      quiet: live.filter((l) => now - l.updated_at > QUIET_MS).length,
      lastMoved: last
        ? { lane: last.id, title: last.title, owner: last.owner_seat, at: last.updated_at }
        : null,
    };
  });
}
