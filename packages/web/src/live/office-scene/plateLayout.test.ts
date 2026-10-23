import { describe, expect, it } from 'vitest';
import {
  HOME_HOLD_MS,
  MAX_STEPS,
  MOVE_HOLD_MS,
  headBox,
  layoutPlates,
  leaderFrom,
  plateCoversBoard,
  plateRect,
  type PlateBox,
  type PlateMemo,
} from './plateLayout';

/**
 * Nameplates stacked over a neighbour (lane 01M3GPH5KB): the four seats at the meeting table read as
 * "autorefresh" slicing "sloane" to "loane", miley's plate on dolly's head. Plates are pinned above
 * their own head with no idea of each other. `layoutPlates` places them front-to-back into the first
 * free slot near their head.
 */
const W = 80;
const H = 14;
const plate = (name: string, x: number, y: number, w = W): PlateBox => ({
  name,
  anchor: { x, y },
  w,
  h: H,
});
const overlaps = (a: ReturnType<typeof plateRect>, b: ReturnType<typeof plateRect>) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function run(plates: PlateBox[], prev = new Map<string, PlateMemo>(), now = 0) {
  const heads = new Map(plates.map((p) => [p.name, p.anchor]));
  return layoutPlates(plates, heads, prev, { scale: 1, now });
}

describe('layoutPlates', () => {
  it('a plate with room keeps its place straight above its own head', () => {
    const out = run([plate('ada', 100, 100)]);
    expect(out.placements.get('ada')).toEqual({ x: 100, y: 100, displaced: false });
  });

  it('of two plates that would overlap, the one nearer the viewer keeps its place and the other moves clear', () => {
    const out = run([plate('back', 100, 100), plate('front', 160, 104)]);
    expect(out.placements.get('front')!.displaced).toBe(false);
    const back = out.placements.get('back')!;
    expect(back.displaced).toBe(true);
    const rb = plateRect(back, W, H);
    const rf = plateRect(out.placements.get('front')!, W, H);
    expect(overlaps(rb, rf)).toBe(false);
  });

  it('a plate prefers the spot that covers a neighbour’s head least', () => {
    // In the isometric room the member BEHIND is drawn up-screen, so the front member's plate —
    // hanging above the front head — lands on the back member's head. With one step up (nick,
    // 2026-10-22) it cannot always clear that head, so it takes whichever spot covers it least.
    const plates = [plate('behind', 200, 150), plate('front', 200, 175)];
    const out = run(plates);
    const head = headBox({ x: 200, y: 150 }, 1);
    const area = (a: ReturnType<typeof plateRect>, b: ReturnType<typeof plateRect>) => {
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      return w > 0 && h > 0 ? w * h : 0;
    };
    const chosen = area(plateRect(out.placements.get('front')!, W, H), head);
    const home = area(plateRect({ x: 200, y: 175 }, W, H), head);
    expect(chosen).toBeLessThanOrEqual(home);
  });

  it('the meeting-table cluster: nobody floats off, and names overlap only partly', () => {
    // Four seats round a table, heads 20–40 px apart — the screenshot that opened lane 01M3GPH5KB.
    // Vertical-only plates cannot all clear four heads this close, so this pins what matters: every
    // plate stays within MAX_STEPS of its head, and (nick, 2026-10-22: some overlap is the price of low plates) no two
    // names overlap by more than three quarters of one plate.
    const plates = [
      plate('autorefresh', 400, 300, 118),
      plate('sloane', 440, 305),
      plate('miley', 425, 322),
      plate('dolly', 430, 350),
    ];
    const out = run(plates);
    const area = (a: ReturnType<typeof plateRect>, b: ReturnType<typeof plateRect>) => {
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      return w > 0 && h > 0 ? w * h : 0;
    };
    for (const p of plates) expect(out.memo.get(p.name)!.slot).toBeLessThanOrEqual(MAX_STEPS);
    const rects = plates.map((p) => ({
      name: p.name,
      r: plateRect(out.placements.get(p.name)!, p.w, H),
    }));
    for (const a of rects)
      for (const b of rects)
        if (a.name < b.name)
          expect(area(a.r, b.r), `${a.name} × ${b.name}`).toBeLessThanOrEqual(0.75 * W * H);
  });

  it('keeps a displaced plate where it is while that spot still works — no flicker as people walk', () => {
    const first = run([plate('back', 100, 100), plate('front', 160, 104)]);
    const slot = first.memo.get('back')!.slot;
    // The front member drifts a couple of pixels: the back plate must not hop to a different slot.
    const second = run([plate('back', 100, 100), plate('front', 161, 105)], first.memo);
    expect(second.memo.get('back')!.slot).toBe(slot);
  });

  it('returns a plate home only once home has stayed clear for HOME_HOLD_MS', () => {
    const first = run([plate('back', 100, 100), plate('front', 160, 104)]);
    expect(first.placements.get('back')!.displaced).toBe(true);
    const apart = [plate('back', 100, 100), plate('front', 400, 104)];
    // Home just came free: the plate waits rather than flipping back the same frame.
    const waiting = run(apart, first.memo, 1000);
    expect(waiting.placements.get('back')!.displaced).toBe(true);
    const still = run(apart, waiting.memo, 1000 + HOME_HOLD_MS - 1);
    expect(still.placements.get('back')!.displaced).toBe(true);
    const home = run(apart, still.memo, 1000 + HOME_HOLD_MS);
    expect(home.placements.get('back')).toEqual({ x: 100, y: 100, displaced: false });
  });

  it('a settled plate moves only after its spot has been blocked for MOVE_HOLD_MS', () => {
    const alone = run([plate('back', 100, 100)]);
    const crowd = [plate('back', 100, 100), plate('front', 160, 104)];
    const t0 = run(crowd, alone.memo, 5000);
    expect(t0.placements.get('back')!.displaced).toBe(false);
    const held = run(crowd, t0.memo, 5000 + MOVE_HOLD_MS - 1);
    expect(held.placements.get('back')!.displaced).toBe(false);
    const moved = run(crowd, held.memo, 5000 + MOVE_HOLD_MS);
    expect(moved.placements.get('back')!.displaced).toBe(true);
  });

  it('a block that clears inside the hold never moves the plate — the ping-pong is gone', () => {
    const alone = run([plate('back', 100, 100)]);
    const blip = run([plate('back', 100, 100), plate('front', 160, 104)], alone.memo, 0);
    const clear = run([plate('back', 100, 100), plate('front', 400, 104)], blip.memo, 200);
    const later = run([plate('back', 100, 100), plate('front', 160, 104)], clear.memo, 400);
    const after = run([plate('back', 100, 100), plate('front', 160, 104)], later.memo, 800);
    // Blocked at 0, clear at 200 (the timer resets), blocked again at 400: 800 is only 400ms in.
    expect(after.placements.get('back')!.displaced).toBe(false);
  });

  it('never more than MAX_STEPS up, however crowded', () => {
    const crowd = Array.from({ length: 9 }, (_, i) =>
      plate(`m${i}`, 300 + (i % 3) * 6, 300 + Math.floor(i / 3) * 6),
    );
    const out = run(crowd);
    for (const p of crowd) expect(out.memo.get(p.name)!.slot).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('a plate remembered on a step this layout no longer has is placed again, within the cap', () => {
    // The cap was two steps before 2026-10-22; a memo from then must not park a plate higher than one.
    const plates = [plate('back', 100, 100), plate('front', 160, 104)];
    const high = new Map<string, PlateMemo>([
      ['back', { slot: 2, blockedAt: null, lowerFreeAt: null }],
    ]);
    const t0 = run(plates, high, 0);
    expect(t0.memo.get('back')!.slot).toBeLessThanOrEqual(MAX_STEPS);
  });

  it('walkers yield: someone passing never moves a seated plate, and keeps their own over their head', () => {
    const out = run([plate('seated', 100, 100), { ...plate('walker', 160, 104), moving: true }]);
    expect(out.placements.get('seated')).toEqual({ x: 100, y: 100, displaced: false });
    expect(out.placements.get('walker')).toEqual({ x: 160, y: 104, displaced: false });
  });

  it('plates only step straight up — never sideways across a desk', () => {
    const plates = [
      plate('autorefresh', 400, 300, 118),
      plate('sloane', 440, 305),
      plate('miley', 425, 322),
      plate('dolly', 430, 350),
    ];
    const out = run(plates);
    for (const p of plates) expect(out.placements.get(p.name)!.x).toBe(p.anchor.x);
  });

  it('a settled plate rides out a sliver of overlap instead of jumping', () => {
    const first = run([plate('back', 100, 100), plate('front', 190, 104)]);
    expect(first.memo.get('back')!.slot).toBe(0);
    // Front drifts left until its plate's edge touches back's — a couple of px, not a collision.
    const creep = [plate('back', 100, 100), plate('front', 178, 104)];
    const later = run(creep, first.memo, 10_000);
    const muchLater = run(creep, later.memo, 10_000 + MOVE_HOLD_MS * 4);
    expect(muchLater.memo.get('back')!.slot).toBe(0);
  });

  it('when nowhere is free, a plate takes the spot that overlaps least, never disappears', () => {
    const crowd = Array.from({ length: 9 }, (_, i) =>
      plate(`m${i}`, 300 + (i % 3) * 6, 300 + Math.floor(i / 3) * 6),
    );
    const out = run(crowd);
    expect(out.placements.size).toBe(9);
  });
});

describe('leaderFrom — the hairline back to a displaced plate’s head', () => {
  const inside = (x: number, y: number, r: ReturnType<typeof plateRect>) =>
    x > r.x0 + 0.5 && x < r.x1 - 0.5 && y > r.y0 + 0.5 && y < r.y1 - 0.5;

  it('starts at the plate edge nearest the head, and never runs back through the plate', () => {
    // A plate stepped to the RIGHT of its head, at head level: the head is up-left of it.
    const at = { x: 200, y: 120 };
    const head = { x: 130, y: 100 };
    const lead = leaderFrom(at, W, H, head);
    const r = plateRect(at, W, H);
    expect(lead.start.x).toBeCloseTo(r.x0, 5); // the left edge — the side facing the head
    for (let t = 0.05; t <= 1; t += 0.05) {
      const x = lead.start.x + Math.cos(lead.angle) * lead.len * t;
      const y = lead.start.y + Math.sin(lead.angle) * lead.len * t;
      expect(inside(x, y, r), `point ${t.toFixed(2)} of the leader is inside the plate`).toBe(
        false,
      );
    }
    const end = {
      x: lead.start.x + Math.cos(lead.angle) * lead.len,
      y: lead.start.y + Math.sin(lead.angle) * lead.len,
    };
    expect(end.x).toBeCloseTo(head.x, 5);
    expect(end.y).toBeCloseTo(head.y, 5);
  });

  it('a plate raised straight above its head leaves from its bottom edge', () => {
    const lead = leaderFrom({ x: 100, y: 80 }, W, H, { x: 100, y: 100 });
    expect(lead.start).toEqual({ x: 100, y: 80 });
  });
});

describe('the head box is the head', () => {
  it('stops at the chin — clearing a neighbour’s shoulders is what sent plates five steps up', () => {
    const b = headBox({ x: 0, y: 0 }, 1);
    expect(b.y1).toBeLessThanOrEqual(34);
  });
});

describe('plateCoversBoard — a wide plate must not hide the wall board (lane 01M4VNDVF7)', () => {
  const board = { x0: 800, y0: 200, x1: 920, y1: 290 };
  it('covers the board when a 350 px plate anchored to its left runs across the face', () => {
    // anchored at x=700, 350 wide: spans 525..875, and sits at y 260..280 — over the board's lower-left
    expect(plateCoversBoard({ x: 700, y: 280 }, 350, 20, board)).toBe(true);
  });
  it('is clear once the plate is narrow enough (the chip dropped) or anchored elsewhere', () => {
    expect(plateCoversBoard({ x: 700, y: 280 }, 120, 20, board)).toBe(false); // 640..760
    expect(plateCoversBoard({ x: 300, y: 280 }, 350, 20, board)).toBe(false); // far left
    expect(plateCoversBoard({ x: 700, y: 340 }, 350, 20, board)).toBe(false); // below the board
  });
  it('lets a sliver go: a plate grazing the board edge is not a cover', () => {
    // 4 px of horizontal overlap on a 20 px tall plate: well under the share of its own area
    expect(plateCoversBoard({ x: 627, y: 280 }, 350, 20, board)).toBe(false); // right edge 802
  });
});
