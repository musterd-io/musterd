import type { LaneBoard, LaneState } from '@musterd/protocol';

/**
 * The wall board's data shape — the real lane board squinted at from across the room.
 *
 * The office's agile board (the object that replaced the dry-erase whiteboard) can't render titles:
 * at /live's ~0.52 scale anything under ~10 logical units is an unreadable smear, so a lane becomes
 * a *sticky note* — a colored rectangle in the right column — and the board communicates entirely
 * through where the paper is. That is honest kanban: you read a real board across an office the
 * same way.
 *
 * Columns mirror `Board.tsx` COLUMNS exactly (the overlay the click opens), so what you glimpse on
 * the wall and what you get up close are the same board at two distances: `ready_for_review` folds
 * into `awaiting_acceptance` (ADR 192) and `abandoned` has no column.
 */
export interface WallSticky {
  /** Stable per-lane hash — seeds the placement jitter so notes don't reshuffle on repaint. */
  seed: number;
  state: LaneState;
  /** Someone is walking off with this card (a claim in flight): its slot stays, its paper does not. */
  taken?: true;
  /** Seconds since a pin walk landed this card (L5): it swings on its tape for a moment, then hangs still. */
  age?: number;
}

export interface WallBoardColumn {
  key: LaneState;
  /** True lane count — the badge shows this when it exceeds what the wall can pin. */
  count: number;
  /** At most STICKY_CAP notes, board order preserved. */
  stickies: WallSticky[];
}

export type WallBoard = WallBoardColumn[];

/** Column order on the wall — one-to-one with Board.tsx COLUMNS. */
export const WALL_COLUMNS: readonly LaneState[] = [
  'open',
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'done',
];

/** How many stickies fit down one wall column before the count badge takes over. */
export const STICKY_CAP = 4;

/** Tiny stable string hash (FNV-1a, 32-bit) — placement jitter only, zero crypto pretensions. */
export function laneSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The board as it reads while someone has a card in their hand (nick, 2026-10-09): a lane being claimed
 * leaves an empty slot in the OPEN column from the moment it is taken until the board's own refresh
 * moves it to "claimed". Only the open column — the same lane already showing under "claimed" is the
 * card arriving, not leaving. Pure; returns the input untouched when nothing is taken.
 */
export function withTaken(board: WallBoard | null, taken: readonly number[]): WallBoard | null {
  if (!board || taken.length === 0) return board;
  const t = new Set(taken);
  return board.map((col) =>
    col.key !== 'open' || !col.stickies.some((s) => t.has(s.seed))
      ? col
      : { ...col, stickies: col.stickies.map((s) => (t.has(s.seed) ? { ...s, taken: true as const } : s)) },
  );
}

/** Project the real lane board down to what the wall can carry. Null in, null out. */
/** A card on its way back to the wall (a resolve or submit in flight): which lane, and which column it
 *  is being pinned under. */
export interface PinnedCard {
  seed: number;
  state: LaneState;
  /** Seconds since the card landed, when it did this session (see `WallSticky.age`). */
  age?: number;
}

/**
 * The board as it reads once someone has pinned a card (nick, 2026-10-12): from the pin leg of the
 * walk until the board's own refresh catches up, the lane's sticky hangs under its NEW column and
 * nowhere else. Moving it (rather than adding a second) is what keeps a lane one card on the wall
 * whichever of the two sources is ahead. Pure; returns the input untouched when nothing is pinned.
 */
export function withPinned(board: WallBoard | null, pinned: readonly PinnedCard[]): WallBoard | null {
  if (!board || pinned.length === 0) return board;
  const moved = new Map(pinned.map((p) => [p.seed, p.state]));
  const ages = new Map(pinned.filter((p) => p.age !== undefined).map((p) => [p.seed, p.age!]));
  return board.map((col) => {
    const stickies = [
      // A card the board already shows here still swings if it only just landed (`age`).
      ...col.stickies
        .filter((s) => !moved.has(s.seed) || moved.get(s.seed) === col.key)
        .map((s) => (ages.has(s.seed) ? { ...s, age: ages.get(s.seed)! } : s)),
      ...pinned
        .filter((p) => p.state === col.key && !col.stickies.some((s) => s.seed === p.seed))
        .map((p) => ({ seed: p.seed, state: p.state, ...(p.age !== undefined ? { age: p.age } : {}) })),
    ];
    const same =
      stickies.length === col.stickies.length && stickies.every((s, i) => s === col.stickies[i]);
    return same ? col : { ...col, stickies };
  });
}

export function projectWallBoard(board: LaneBoard | null): WallBoard | null {
  if (!board) return null;
  const byState = new Map<LaneState, WallBoardColumn>(
    WALL_COLUMNS.map((key) => [key, { key, count: 0, stickies: [] }]),
  );
  for (const lane of board.lanes) {
    const key = lane.state === 'ready_for_review' ? 'awaiting_acceptance' : lane.state;
    const col = byState.get(key);
    if (!col) continue; // abandoned — no column
    col.count++;
    if (col.stickies.length < STICKY_CAP) {
      col.stickies.push({ seed: laneSeed(lane.id), state: lane.state });
    }
  }
  return WALL_COLUMNS.map((key) => byState.get(key)!);
}
