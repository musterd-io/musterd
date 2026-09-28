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
 * OTHER member's head. A plate off its home spot is `displaced`, and the scene draws a hairline leader
 * back to its head so ownership stays unambiguous.
 *
 * Stable on purpose: a plate goes home the moment home is free, and otherwise keeps the slot it had
 * while that slot still works — so a walker drifting a pixel past a seated row does not make its
 * plates hop. Pure and DOM-free: the scene measures plates and applies the result.
 */

/** A plate to place: its member, the anchor above the head (render.ts `heads`), and its size in px. */
export interface PlateBox {
  name: string;
  anchor: Pt;
  w: number;
  h: number;
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
 * The part of a member a plate must never cover: their head and shoulders, just under the plate
 * anchor (render.ts lifts the anchor clear of the crown and the firefly over it). Down to the
 * shoulders, because a plate stepped beside one head at crown height otherwise lands on the next
 * member's torso — seen on the meeting table in the preview.
 */
export function headBox(anchor: Pt, scale: number): Rect {
  return {
    x0: anchor.x - 14 * scale,
    y0: anchor.y + 4 * scale,
    x1: anchor.x + 14 * scale,
    y1: anchor.y + 52 * scale,
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
const MARGIN = 2;
/** Vertical gap between stacked plates, px. */
const GAP = 3;

function overlapArea(a: Rect, b: Rect, m = 0): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 2 * m;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 2 * m;
  return w > 0 && h > 0 ? w * h : 0;
}

/** The candidate spots around a head, in order of preference. Slot 0 is home. */
function slotAt(i: number, p: PlateBox, scale: number): PlatePlacement {
  const { x, y } = p.anchor;
  const up = p.h + GAP;
  const side = p.w / 2 + 16 * scale; // clear of the head's width
  switch (i) {
    case 0:
      return { x, y, displaced: false };
    case 1:
      return { x, y: y - up, displaced: true };
    case 2:
      return { x: x - side, y: y + p.h + 8 * scale, displaced: true }; // beside the crown, left
    case 3:
      return { x: x + side, y: y + p.h + 8 * scale, displaced: true }; // …right
    case 4:
      return { x, y: y - 2 * up, displaced: true };
    case 5:
      return { x: x - side, y, displaced: true };
    case 6:
      return { x: x + side, y, displaced: true };
    default:
      return { x, y: y - 3 * up, displaced: true };
  }
}
const SLOTS = 8;

export function layoutPlates(
  plates: readonly PlateBox[],
  heads: ReadonlyMap<string, Pt>,
  prev: ReadonlyMap<string, number>,
  opts: { scale: number },
): { placements: Map<string, PlatePlacement>; slots: Map<string, number> } {
  const placements = new Map<string, PlatePlacement>();
  const slots = new Map<string, number>();
  const placed: Rect[] = [];
  // Every head's box, built once per frame rather than once per plate — this runs on every frame.
  const headNames: string[] = [];
  const headRects: Rect[] = [];
  for (const [name, at] of heads) {
    headNames.push(name);
    headRects.push(headBox(at, opts.scale));
  }
  const order = [...plates].sort((a, b) => b.anchor.y - a.anchor.y || a.name.localeCompare(b.name));
  for (const p of order) {
    const cost = (i: number): number => {
      const r = plateRect(slotAt(i, p, opts.scale), p.w, p.h);
      let c = 0;
      for (const o of placed) c += overlapArea(r, o, MARGIN);
      for (let k = 0; k < headRects.length; k++)
        if (headNames[k] !== p.name) c += overlapArea(r, headRects[k]!, MARGIN);
      return c;
    };
    // Home if home is free; else the slot it already had, if that still works; else the first free.
    let pick = -1;
    if (cost(0) === 0) pick = 0;
    else {
      const had = prev.get(p.name);
      if (had !== undefined && had > 0 && had < SLOTS && cost(had) === 0) pick = had;
      else {
        let best = 0;
        let bestCost = Infinity;
        for (let i = 1; i < SLOTS; i++) {
          const c = cost(i);
          if (c === 0) {
            best = i;
            bestCost = 0;
            break;
          }
          if (c < bestCost) {
            best = i;
            bestCost = c;
          }
        }
        pick = best;
      }
    }
    const at = slotAt(pick, p, opts.scale);
    placements.set(p.name, at);
    slots.set(p.name, pick);
    placed.push(plateRect(at, p.w, p.h));
  }
  return { placements, slots };
}
