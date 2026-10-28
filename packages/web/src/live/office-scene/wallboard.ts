import type { LaneBoard, LaneState } from '@musterd/protocol';
import type { ReadStatus } from '../experimentReads';

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
  /** Stable per-lane hash — seeds the tilt and a place when the daemon recorded none. */
  seed: number;
  state: LaneState;
  /** Which goal row the card hangs in: an index into `WallBoard.rows`. */
  row: number;
  /** Where in its cell (goal row × column), each `0..1` — the daemon's recorded place (ADR 751), or a
   *  seeded one from an older daemon. A card keeps this until someone moves it. */
  x: number;
  y: number;
  /** When it was put there — a cell paints its cards oldest first, so a pile reads newest on top. */
  at: number;
  /** Who put it there (ADR 751 `card.by`): the member the room shows moving it. */
  by?: string;
  /** Someone is walking off with this card (a claim in flight): its place stays, its paper does not. */
  taken?: true;
  /** Seconds since a pin walk landed this card (L5): it swings on its tape for a moment, then hangs still. */
  age?: number;
  /** Part of a plan that stopped (lane 01M4V9YKMG): the paper is sun-faded. */
  faded?: true;
}

/** A place on the cork where a card hung this week and no longer does (lane 01M50WEBTC). */
export interface WallHole {
  row: number;
  x: number;
  y: number;
}

export interface WallBoardColumn {
  key: LaneState;
  /** True lane count in this column, every row. */
  count: number;
  /** Every card in the column, every row, oldest first. */
  stickies: WallSticky[];
  /** Tack holes: where a lane hung in this column this week before it moved on. Absent = none. */
  holes?: WallHole[];
}

/**
 * One goal row on the board (ADR 751 spec, "The board"): the team's in-flight goals in their own
 * order, up to {@link GOAL_ROWS}, then one row for everything else. `label` is what its washi tab
 * says; `tone` picks the tab's tape.
 */
export interface WallRow {
  /** Null for the everything-else row. */
  goalId: string | null;
  label: string;
  tone: number;
}

/**
 * The columns, plus the goal rows and the team's dated reads (ADR 644 increment 3): one pin each
 * along the cork strip under the rows, in the Experiments section's order. Absent `reads` = none;
 * absent `rows` = one unlabelled row (a board built without goals).
 */
export type WallBoard = WallBoardColumn[] & {
  reads?: readonly ReadStatus[];
  rows?: readonly WallRow[];
  /** Lanes abandoned today (local midnight on), oldest first: their cards are crumpled in the bin. */
  binned?: readonly { seed: number; by: string }[];
};

/** How many goals get a row of their own before the rest share the last one. */
export const GOAL_ROWS = 4;

/** How many read pins the strip holds. Past this, the last slot is a "+" card. */
export const READ_PIN_CAP = 8;

/** The pins the strip shows, in order: every read when they fit, else the first seven and a "+". */
export function readPins(reads: readonly ReadStatus[] | undefined): (ReadStatus | 'more')[] {
  if (!reads?.length) return [];
  return reads.length <= READ_PIN_CAP ? [...reads] : [...reads.slice(0, READ_PIN_CAP - 1), 'more'];
}

/** A column-wise rewrite keeps the reads and the rows riding along with it. */
function keepReads(from: WallBoard, cols: WallBoardColumn[]): WallBoard {
  return Object.assign(
    cols,
    from.reads ? { reads: from.reads } : {},
    from.rows ? { rows: from.rows } : {},
    from.binned ? { binned: from.binned } : {},
  );
}

/** Column order on the wall — one-to-one with Board.tsx COLUMNS. */
export const WALL_COLUMNS: readonly LaneState[] = [
  'open',
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'done',
];

/** The board column a lane's card hangs in, or null when it is off the board — protocol's
 *  `laneCardColumn` (ADR 751), restated here because the protocol barrel is not browser-safe. */
function cardColumn(state: LaneState): LaneState | null {
  if (state === 'ready_for_review') return 'awaiting_acceptance';
  return (WALL_COLUMNS as readonly string[]).includes(state) ? state : null;
}

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
  return keepReads(board, board.map((col) =>
    col.key !== 'open' || !col.stickies.some((s) => t.has(s.seed))
      ? col
      : { ...col, stickies: col.stickies.map((s) => (t.has(s.seed) ? { ...s, taken: true as const } : s)) },
  ));
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
  // The card keeps its row and its place: the walk carries it across, and the daemon's own place for
  // the new column arrives with the next board (ADR 751).
  const was = new Map<number, WallSticky>();
  for (const col of board) for (const s of col.stickies) was.set(s.seed, s);
  const lastRow = Math.max(0, (board.rows?.length ?? 1) - 1);
  return keepReads(board, board.map((col) => {
    const stickies = [
      // A card the board already shows here still swings if it only just landed (`age`).
      ...col.stickies
        .filter((s) => !moved.has(s.seed) || moved.get(s.seed) === col.key)
        .map((s) => (ages.has(s.seed) ? { ...s, age: ages.get(s.seed)! } : s)),
      ...pinned
        .filter((p) => p.state === col.key && !col.stickies.some((s) => s.seed === p.seed))
        .map((p): WallSticky => {
          const o = was.get(p.seed);
          return {
            seed: p.seed,
            state: p.state,
            row: o?.row ?? lastRow,
            x: o?.x ?? 0.5,
            y: o?.y ?? 0.5,
            at: Number.MAX_SAFE_INTEGER, // just pinned: on top of its pile
            ...(p.age !== undefined ? { age: p.age } : {}),
          };
        }),
    ];
    const same =
      stickies.length === col.stickies.length && stickies.every((s, i) => s === col.stickies[i]);
    return same ? col : { ...col, stickies };
  }));
}

/** How far back a lane that moved on still leaves its holes (lane 01M50WEBTC). */
export const HOLES_WINDOW_MS = 7 * 86_400_000;
/** Where a column sits on a lane's way through the board. `blocked` shares `active`'s place and is
 *  never passed through: the board cannot tell which lanes were blocked before. */
const RANK: Partial<Record<LaneState, number>> = {
  open: 0,
  claimed: 1,
  active: 2,
  blocked: 2,
  awaiting_acceptance: 3,
  done: 4,
};

/** A place for a card the daemon has recorded none for (an older daemon), seeded per lane and column. */
export function seededPlace(seed: number, salt = 0): { x: number; y: number } {
  const h = Math.imul(seed ^ (salt * 0x9e3779b1), 0x85ebca6b) >>> 0;
  return { x: 0.12 + ((h & 0xffff) / 0xffff) * 0.76, y: 0.15 + ((h >>> 16) / 0xffff) * 0.7 };
}

/** A goal's tab word: the first part of its id ("office-realism" → "office"), at most nine letters. */
function tabLabel(goalId: string): string {
  return (goalId.split(/[-_ ]/)[0] ?? goalId).slice(0, 9);
}

export function projectWallBoard(
  board: LaneBoard | null,
  stalled: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
  /** The Experiments section's statuses, in its order (`experimentEntries`). */
  reads: readonly ReadStatus[] = [],
  /** The team's goal ids in its own order (`report.goals`, wave-ordered). Empty: one row. */
  goals: readonly string[] = [],
): WallBoard | null {
  if (!board) return null;
  const onBoard = board.lanes.filter((l) => cardColumn(l.state) !== null);
  // Rows (ADR 751 spec): the first GOAL_ROWS goals, in the team's order, that have a card up; then
  // one row for the rest. Activity never reorders them, so a card never jumps rows on its own.
  const withCards = new Set(onBoard.map((l) => l.goal_id).filter((g): g is string => g !== null));
  const own = goals.filter((g) => withCards.has(g)).slice(0, GOAL_ROWS);
  const rowOf = new Map(own.map((g, i) => [g, i]));
  const rows: WallRow[] = own.map((g, i) => ({ goalId: g, label: tabLabel(g), tone: i }));
  const restRow = rows.length;
  if (onBoard.some((l) => l.goal_id === null || !rowOf.has(l.goal_id)))
    rows.push({ goalId: null, label: rows.length ? 'other' : '', tone: GOAL_ROWS });
  const byState = new Map<LaneState, WallBoardColumn>(
    WALL_COLUMNS.map((key) => [key, { key, count: 0, stickies: [] }]),
  );
  for (const lane of onBoard) {
    const key = cardColumn(lane.state)!;
    const col = byState.get(key)!;
    const seed = laneSeed(lane.id);
    const row = lane.goal_id !== null ? (rowOf.get(lane.goal_id) ?? restRow) : restRow;
    const place = lane.card ?? seededPlace(seed);
    col.count++;
    col.stickies.push({
      seed,
      state: lane.state,
      row,
      x: place.x,
      y: place.y,
      at: lane.card?.at ?? lane.updated_at,
      ...(lane.card ? { by: lane.card.by } : {}),
      ...(stalled.has(lane.id) ? { faded: true as const } : {}),
    });
    // Pin holes (lane 01M50WEBTC): a lane updated this week hung in every column before its own, in
    // its own row, so those cells keep a hole. Derived from the board alone, so every viewer sees the
    // same cork; a quiet team's cork starts clean and wears in.
    if (lane.updated_at >= now - HOLES_WINDOW_MS)
      for (const [k, other] of byState)
        if (k !== 'blocked' && RANK[k]! < RANK[key]!)
          (other.holes ??= []).push({ row, ...seededPlace(seed, RANK[k]! + 1) });
  }
  const cols = WALL_COLUMNS.map((key) => {
    const col = byState.get(key)!;
    col.stickies.sort((a, b) => a.at - b.at);
    return col;
  });
  // The bin (ADR 751): today's abandoned lanes, crumpled. An abandon clears the card, so who threw
  // it away is the lane's last owner, else its opener.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const binned = board.lanes
    .filter((l) => l.state === 'abandoned' && l.updated_at >= midnight.getTime())
    .sort((a, b) => a.updated_at - b.updated_at)
    .map((l) => ({ seed: laneSeed(l.id), by: l.owner_seat ?? l.created_by }));
  return Object.assign(cols, { rows }, reads.length ? { reads } : {}, binned.length ? { binned } : {});
}

/** How long a landed card swings before it hangs still, in seconds. */
export const STICKY_SWAY_S = 1.1;

/**
 * The bottom-edge shear of a card that just landed, in board units (the top edge stays on its tape). Two
 * swings that die away over about a second: the peak is ~4 units on a 17-unit card, which is ~2.7 px at
 * a 1280-wide stage — the first cut peaked at 1.7 units (~1 px, gone in 0.3 s) and could not be seen.
 * `undefined` (never landed this session) and anything past `STICKY_SWAY_S` are zero.
 */
export function stickySway(age: number | undefined): number {
  if (age === undefined || age < 0 || age >= STICKY_SWAY_S) return 0;
  return Math.sin(age * 14) * Math.exp(-age * 2.8) * 5.5;
}

/** Where a card hung on the previous board: its column, row and place. */
export interface CardSpot {
  state: LaneState;
  row: number;
  x: number;
  y: number;
}

/**
 * One recorded change of the board for the room to act out (ADR 751 spec, "Moves"): a card that
 * appeared, a card that moved (column, row or place), or a card thrown away. `by` is who did it.
 */
export type BoardMove =
  | { kind: 'pin'; seed: number; by: string; state: LaneState }
  | { kind: 'move'; seed: number; by: string; state: LaneState; from: CardSpot }
  | { kind: 'toss'; seed: number; by: string; from: CardSpot };

const spotOf = ({ state, row, x, y }: CardSpot): CardSpot => ({ state, row, x, y });

function spots(board: WallBoard): Map<number, CardSpot & { by?: string }> {
  const out = new Map<number, CardSpot & { by?: string }>();
  for (const col of board)
    for (const s of col.stickies)
      out.set(s.seed, { state: col.key, row: s.row, x: s.x, y: s.y, ...(s.by ? { by: s.by } : {}) });
  return out;
}

/**
 * What changed between two boards, for the room to walk. Pure. A card a walk is already carrying
 * (`skip`: the claim, pin and deliver walks the acts start) is left to that walk. A card with no
 * recorded mover (an older daemon) moves without anyone walking it.
 */
export function boardMoves(
  prev: WallBoard | null,
  next: WallBoard | null,
  skip: ReadonlySet<number> = new Set(),
): BoardMove[] {
  if (!prev || !next) return [];
  const was = spots(prev);
  const now = spots(next);
  const out: BoardMove[] = [];
  for (const [seed, n] of now) {
    if (skip.has(seed) || !n.by) continue;
    const o = was.get(seed);
    if (!o) out.push({ kind: 'pin', seed, by: n.by, state: n.state });
    else if (o.state !== n.state || o.row !== n.row || o.x !== n.x || o.y !== n.y)
      out.push({ kind: 'move', seed, by: n.by, state: n.state, from: spotOf(o) });
  }
  const tossed = new Map((next.binned ?? []).map((b) => [b.seed, b.by]));
  for (const [seed, o] of was) {
    if (now.has(seed) || skip.has(seed)) continue;
    const by = tossed.get(seed);
    if (by) out.push({ kind: 'toss', seed, by, from: spotOf(o) });
  }
  return out;
}

/** A card the room is moving right now, and how far the walk has got. */
export interface CardInFlight {
  seed: number;
  /** Where it hung before; absent for a card arriving for the first time. */
  from?: CardSpot;
  /** `before`: still on the cork at `from`; `hand`: off the board; `gone`: thrown away. */
  phase: 'before' | 'hand';
}

/**
 * The board as it reads while a move or a toss walk is under way: until the hand takes it, the card
 * still hangs where it was; while it is in the hand, it hangs nowhere. The landing needs nothing —
 * the board already shows the card at its new place. A tossed card's ball joins the bin only once
 * thrown, so a toss in flight also holds its ball back. Pure.
 */
export function withMoving(board: WallBoard | null, moving: readonly CardInFlight[]): WallBoard | null {
  if (!board || moving.length === 0) return board;
  const bySeed = new Map(moving.map((m) => [m.seed, m]));
  const cols = board.map((col) => {
    const kept = col.stickies.filter((s) => !bySeed.has(s.seed));
    const back = moving
      .filter((m) => m.phase === 'before' && m.from?.state === col.key)
      .map((m): WallSticky => ({ seed: m.seed, state: col.key, row: m.from!.row, x: m.from!.x, y: m.from!.y, at: 0 }));
    return kept.length === col.stickies.length && back.length === 0
      ? col
      : { ...col, stickies: [...back, ...kept] };
  });
  const out = keepReads(board, cols);
  if (board.binned?.some((b) => bySeed.has(b.seed)))
    out.binned = board.binned.filter((b) => !bySeed.has(b.seed));
  return out;
}

