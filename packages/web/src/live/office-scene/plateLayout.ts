import type { Pt } from './iso';

/**
 * Where each nameplate goes (lane 01M3GPH5KB). A plate used to be pinned straight above its own head
 * and knew nothing about anything else, so wherever seats sit close — the meeting table, the lounge,
 * a pod row — the space above one head is where a neighbour is drawn: "autorefresh" sliced "sloane" to
 * "loane", a plate sat on the head of the member behind. In an isometric room the member behind is
 * drawn UP-screen, exactly where a front member's plate hangs.
 *
 * So plates are placed front-to-back (nearest the viewer first — it is the one in front, and the one
 * a viewer reads first), each into the first free slot near its own head: straight above, a step
 * higher, beside the head, higher still. Free means clear of every plate already placed and of every
 * OTHER member's head. A plate off its home spot is `displaced`, and the scene draws a thin leader
 * back to its head so ownership stays unambiguous.
 *
 * CALM ON PURPOSE (nick, 2026-10-06: the repositioning was "very distracting for the viewer").
 * Measured on the live stream that day: 126 plate jumps in 90 seconds, ~120 of them in one 10-second
 * burst, most 90–190px, some plates flipping home↔away every half second. The first cut re-solved
 * every frame with no memory beyond "keep the slot while it works", jumped sideways ~95px to beside
 * the head, sent a plate home the instant home was free, and placed walkers like anyone else — so
 * one person walking down a row shoved every seated plate out and back. Five rules now, together:
 *
 *  1. Walkers yield. A seated plate never moves for someone passing; the walker's own plate stays
 *     over its head and may overlap for the moment it takes to pass.
 *  2. Hold before moving: a plate leaves its spot only once that spot has been blocked for
 *     `MOVE_HOLD_MS`, and steps back down only once a lower spot has been free for `HOME_HOLD_MS`.
 *  3. Vertical only, and not far: at most `MAX_STEPS` up. The beside-the-head slots are gone.
 *  4. A sliver is not a collision. A plate already settled stays put through an overlap up to
 *     `SLACK` of its own area. A fresh placement still looks for a fully clear spot first.
 *  5. (In the scene, not here) the step is a glide, not a snap — see `.lc-gl-label`'s `translate`.
 *
 * NOT TOO HIGH, AGAIN (nick, 2026-10-22): the cap went from two steps to one and he accepts the trade — a plate in a
 * tight cluster that cannot clear within one step stays on its least-covered spot rather than floating higher.
 *
 * NOT TOO HIGH (nick, same evening, on the build that shipped the rules above: "some of the
 * nameplates are too high above the member avatars"). Measured on the stream: in the lounge, dolly's
 * plate sat five steps (138px) up and miley's four (110px), each on a long leader. Three causes, each
 * fixed: up to five steps were allowed; a head's box ran down to the shoulders, so a plate over a
 * front seat had to clear the whole upper body of the seat behind it; and a raised plate only ever
 * went HOME, never down to a lower step that had come free. Now: two steps at most, a head is the
 * head (a plate may cross a neighbour's shoulders — it is a label over a body, not over a face), a
 * plate settles on the lowest spot it can, and when nothing is clear within two steps it takes the
 * least-covered one — a slightly overlapped plate next to its member reads; one floating off does not.
 *
 * Pure and DOM-free: the scene measures plates, passes the clock, and applies the result.
 */

/** A plate to place: its member, the anchor above the head (render.ts `heads`), and its size in px. */
export interface PlateBox {
  name: string;
  anchor: Pt;
  w: number;
  h: number;
  /** On the move (walking, not seated). A walker's plate yields: it stays over its own head, may
   *  overlap for the moment it takes to pass, and never shoves a seated member's plate. */
  moving?: boolean;
}

/** What a plate remembers between frames — its hysteresis. */
export interface PlateMemo {
  slot: number;
  /** When the plate's current spot first stopped being tolerable; null while it is fine. */
  blockedAt: number | null;
  /** When a lower spot (home, or a smaller step) first came free for a displaced plate; null while
   *  none has, or it is home. */
  lowerFreeAt: number | null;
}

/** Where a plate lands: its bottom-centre (the scene's `translate(-50%, -100%)` point). */
export interface PlatePlacement {
  x: number;
  y: number;
  displaced: boolean;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A plate's rectangle from its bottom-centre placement. */
export function plateRect(p: { x: number; y: number }, w: number, h: number): Rect {
  return { x0: p.x - w / 2, y0: p.y - h, x1: p.x + w / 2, y1: p.y };
}

/**
 * The part of a member a plate must not cover: their head, just under the plate anchor (render.ts
 * lifts the anchor clear of the crown and the firefly over it). It used to run down to the shoulders,
 * for plates stepped BESIDE a head; plates only step up now, and clearing a neighbour's whole upper
 * body is what pushed them five steps into the air (see the header).
 */
export function headBox(anchor: Pt, scale: number): Rect {
  return {
    x0: anchor.x - 14 * scale,
    y0: anchor.y + 4 * scale,
    x1: anchor.x + 14 * scale,
    y1: anchor.y + 32 * scale,
  };
}

/**
 * The leader from a displaced plate back to its head: it leaves from the point of the plate nearest
 * the head, so it never runs back through the plate's own text (it used to leave from the bottom
 * centre, which for a plate stepped beside its head crossed the whole name).
 */
export function leaderFrom(
  at: { x: number; y: number },
  w: number,
  h: number,
  target: Pt,
): { start: Pt; len: number; angle: number } {
  const r = plateRect(at, w, h);
  const start = {
    x: Math.min(Math.max(target.x, r.x0), r.x1),
    y: Math.min(Math.max(target.y, r.y0), r.y1),
  };
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  return { start, len: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

/** Breathing room between two things that must not touch, px. */
const MARGIN = 1;
/** Vertical gap between stacked plates, px — wider than 2×MARGIN, or a plate one step up from another
 *  counts as touching it and every vertical step reads as blocked. */
const GAP = 3;
/** How long a settled plate's spot must stay blocked before it moves. */
export const MOVE_HOLD_MS = 500;
/** How long a displaced plate's home must stay free before it goes back. */
export const HOME_HOLD_MS = 1500;
/** The overlap a settled plate tolerates before it counts as blocked — a share of its own area. */
const SLACK = 0.12;

function overlapArea(a: Rect, b: Rect, m = 0): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 2 * m;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 2 * m;
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Would a plate of this size, placed here, hide the wall board? A plate carries a "working on" chip beside
 * the name, which runs it to ~350 px; anchored over a desk to the board's left it reaches across the
 * board's face and covers the cards (lane 01M4VNDVF7). A sliver is not a cover — under `minShare` of the
 * plate's own area stays put, like `SLACK` for two plates.
 */
export function plateCoversBoard(at: { x: number; y: number }, w: number, h: number, board: Rect, minShare = 0.06): boolean {
  return overlapArea(plateRect(at, w, h), board) > minShare * w * h;
}

/** Straight above the head, `i` steps up. Slot 0 is home. */
function slotAt(i: number, p: PlateBox): PlatePlacement {
  return { x: p.anchor.x, y: p.anchor.y - i * (p.h + GAP), displaced: i > 0 };
}
/** How far up a plate may step: one plate-height (~25px). nick, 2026-10-22: two steps (~50px) still read as
 *  "too high above the member", and he accepts some overlap between plates in a tight cluster instead. */
export const MAX_STEPS = 1;
const SLOTS = MAX_STEPS + 1;

export function layoutPlates(
  plates: readonly PlateBox[],
  heads: ReadonlyMap<string, Pt>,
  prev: ReadonlyMap<string, PlateMemo>,
  opts: { scale: number; now?: number },
): { placements: Map<string, PlatePlacement>; memo: Map<string, PlateMemo> } {
  const now = opts.now ?? 0;
  const placements = new Map<string, PlatePlacement>();
  const memo = new Map<string, PlateMemo>();
  const placed: Rect[] = [];
  // A walker's head is no obstacle either: a seated plate does not move for someone passing by.
  const moving = new Set(plates.filter((p) => p.moving).map((p) => p.name));
  // Every head's box, built once per frame rather than once per plate — this runs on every frame.
  const headNames: string[] = [];
  const headRects: Rect[] = [];
  for (const [name, at] of heads) {
    if (moving.has(name)) continue;
    headNames.push(name);
    headRects.push(headBox(at, opts.scale));
  }
  // Seated plates first, front to back (nearest the viewer is read first); walkers after, and they
  // only ever go home.
  const order = [...plates].sort(
    (a, b) =>
      Number(!!a.moving) - Number(!!b.moving) ||
      b.anchor.y - a.anchor.y ||
      a.name.localeCompare(b.name),
  );
  for (const p of order) {
    if (p.moving) {
      const at = slotAt(0, p);
      placements.set(p.name, at);
      memo.set(p.name, { slot: 0, blockedAt: null, lowerFreeAt: null });
      continue;
    }
    const cost = (i: number): number => {
      const r = plateRect(slotAt(i, p), p.w, p.h);
      let c = 0;
      for (const o of placed) c += overlapArea(r, o, MARGIN);
      for (let k = 0; k < headRects.length; k++)
        if (headNames[k] !== p.name) c += overlapArea(r, headRects[k]!, MARGIN);
      return c;
    };
    const slack = SLACK * p.w * p.h;
    /** The lowest fully clear slot; else the lowest within slack; else the least covered. */
    const best = (): number => {
      let tolerable = -1;
      let pick = 0;
      let low = Infinity;
      for (let i = 0; i < SLOTS; i++) {
        const c = cost(i);
        if (c === 0) return i;
        if (tolerable < 0 && c <= slack) tolerable = i;
        if (c < low) {
          pick = i;
          low = c;
        }
      }
      return tolerable >= 0 ? tolerable : pick;
    };
    /** The lowest spot below `s` that is clear, or -1. */
    const lowerClear = (s: number): number => {
      for (let i = 0; i < s; i++) if (cost(i) === 0) return i;
      return -1;
    };
    const had = prev.get(p.name);
    let next: PlateMemo;
    if (!had || had.slot >= SLOTS) {
      // New to the room (or a slot this layout no longer has): place it, no hold.
      next = { slot: best(), blockedAt: null, lowerFreeAt: null };
    } else {
      const s = had.slot;
      const lower = s > 0 ? lowerClear(s) : -1;
      const lowerFreeAt = lower >= 0 ? (had.lowerFreeAt ?? now) : null;
      const blocked = cost(s) > slack;
      const blockedAt = blocked ? (had.blockedAt ?? now) : null;
      if (lowerFreeAt !== null && now - lowerFreeAt >= HOME_HOLD_MS) {
        next = { slot: lower, blockedAt: null, lowerFreeAt: null };
      } else if (blockedAt !== null && now - blockedAt >= MOVE_HOLD_MS) {
        const to = best();
        // Nowhere better to go: stay, and stop re-checking every frame for nothing.
        next = { slot: cost(to) < cost(s) ? to : s, blockedAt: null, lowerFreeAt: null };
      } else {
        next = { slot: s, blockedAt, lowerFreeAt };
      }
    }
    const at = slotAt(next.slot, p);
    placements.set(p.name, at);
    memo.set(p.name, next);
    placed.push(plateRect(at, p.w, p.h));
  }
  return { placements, memo };
}
