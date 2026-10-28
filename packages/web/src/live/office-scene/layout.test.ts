import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOOR, project, WALL_H } from './iso';
import {
  ART,
  CHECK_IN_MARKS,
  FRONT_DESK,
  RECEPTIONIST,
  BOOKSHELVES,
  CAFE,
  DESK_COMPACT,
  deskDims,
  LOUNGE,
  NOOK,
  SINK,
  STOOL,
  WAIT_CHAIR,
  DESK_D,
  DESK_SLOTS,
  DESK_W,
  ENTRANCE,
  STRIP_CAP,
  FWD,
  LEISURE_SPOTS,
  MAX_S_FACING,
  MEETING,
  MIN_SPOT_GAP,
  NOOK_CAP,
  NOOK_SPOTS,
  POD_SHAPE_SEATS,
  PLANTS,
  PODS,
  RECEPTION,
  SEAT_BACK,
  WALL_BOARD,
  WORKING_HOURS_CALENDAR,
  WINDOWS,
  BENCH,
  WINDOW_DESKS,
} from './layout';

describe('desk pods', () => {
  it('seats 22: bench 4, pinwheel 4, spine 7, zigzag 3, corner duo 2, window 2', () => {
    // 20 on 2026-08-02; 18 → 17 as the floor read crowded; 23 on 2026-10-26 (office v3, spec
    // 2026-10-26-office-v3-design.md §2.1): the v2 figure is smaller and the room has air again.
    // 22 on 2026-10-27: the spine's NE desk went so the café could breathe (nick).
    expect(DESK_SLOTS).toHaveLength(22);
    const podSeats = PODS.reduce((n, p) => n + POD_SHAPE_SEATS[p.shape], 0);
    expect(DESK_SLOTS).toHaveLength(podSeats + BENCH.seats + WINDOW_DESKS.length);
    expect(new Set(DESK_SLOTS.map((s) => s.id)).size).toBe(DESK_SLOTS.length);
    for (const pod of PODS) {
      expect(DESK_SLOTS.filter((s) => s.pod === pod.id)).toHaveLength(POD_SHAPE_SEATS[pod.shape]);
    }
    expect(DESK_SLOTS.filter((s) => s.kind === 'bench')).toHaveLength(BENCH.seats);
    expect(DESK_SLOTS.filter((s) => s.kind === 'window')).toHaveLength(WINDOW_DESKS.length);
  });

  it('keeps at most MAX_S_FACING desks facing the viewer', () => {
    // A face is what makes a member read as a person rather than a coloured block, so the floor needs
    // some — but turning more of it toward the camera would make the room a stage set. Four is the
    // ceiling with 22 desks: the pinwheel gives one, the zigzag at most two.
    expect(DESK_SLOTS.filter((s) => s.dir === 'S').length).toBeLessThanOrEqual(MAX_S_FACING);
  });

  it('turns a pinwheel to face all four ways', () => {
    const pw = PODS.find((p) => p.shape === 'pinwheel')!;
    const dirs = DESK_SLOTS.filter((d) => d.pod === pw.id).map((d) => d.dir);
    expect(new Set(dirs)).toEqual(new Set(['N', 'E', 'S', 'W']));
  });

  it('steps a zigzag so no two desks share a row or a column', () => {
    const z = PODS.find((p) => p.shape === 'zigzag')!;
    const desks = DESK_SLOTS.filter((d) => d.pod === z.id);
    expect(new Set(desks.map((d) => d.lx)).size).toBe(3);
    expect(new Set(desks.map((d) => d.ly)).size).toBe(3);
  });

  it('seats every member outside their pod, on the floor', () => {
    for (const slot of DESK_SLOTS) {
      const f = FWD[slot.dir];
      const seat = { lx: slot.lx - f[0] * SEAT_BACK, ly: slot.ly - f[1] * SEAT_BACK };
      for (const v of [seat.lx, seat.ly]) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(FLOOR);
      }
      if (slot.kind !== 'pod') continue; // bench/window seats have no pod centre to sit outside of
      const pod = PODS[slot.pod]!;
      // the seat is further from the pod centre than the desk is — i.e. the member sits on the outside,
      // backs to the aisle, not squeezed between their desk and the shared screen
      const deskGap = Math.hypot(slot.lx - pod.cx, slot.ly - pod.cy);
      expect(Math.hypot(seat.lx - pod.cx, seat.ly - pod.cy)).toBeGreaterThan(deskGap);
    }
  });

  it('never overlaps two desk slabs', () => {
    // Per-kind footprints: a bench seat owns its stretch of the shared counter, a window desk is a
    // full workstation turned 'ew'. Sizing everything as a pod desk would report the counter's four
    // abutting segments as a pileup.
    const box = (s: (typeof DESK_SLOTS)[number]) => {
      const sn = s.dir === 'S' || s.dir === 'N';
      const w = s.kind === 'bench' ? BENCH.long / BENCH.seats - 1 : sn ? DESK_W : DESK_D;
      const d = s.kind === 'bench' ? BENCH.deep : sn ? DESK_D : DESK_W;
      return { x0: s.lx - w / 2, x1: s.lx + w / 2, y0: s.ly - d / 2, y1: s.ly + d / 2 };
    };
    for (let i = 0; i < DESK_SLOTS.length; i++) {
      for (let j = i + 1; j < DESK_SLOTS.length; j++) {
        const a = box(DESK_SLOTS[i]!);
        const b = box(DESK_SLOTS[j]!);
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
      }
    }
  });
});

describe('plants (office v3-4)', () => {
  it('uses only the three rendered species, and a trailing pothos stands at the pinwheel hub', () => {
    for (const p of PLANTS) expect(['snake', 'fiddle', 'pothos']).toContain(p.species);
    const pw = PODS.find((p) => p.shape === 'pinwheel')!;
    const hub = PLANTS.find((p) => p.lx === pw.cx && p.ly === pw.cy);
    expect(hub?.species).toBe('pothos');
    expect(PLANTS.filter((p) => p.species === 'pothos')).toHaveLength(2);
  });
});

describe('zone rugs', () => {
  it('keeps every rug on the floor slab', () => {
    // A rug that runs past the floor edge paints over the slab's side face and the room looks torn.
    const rugs = [
      { lx: MEETING.lx, ly: MEETING.ly, w: MEETING.rug.w, d: MEETING.rug.d },
      { lx: RECEPTION.rug.lx, ly: RECEPTION.rug.ly, w: RECEPTION.rug.w, d: RECEPTION.rug.d },
    ];
    for (const r of rugs) {
      expect(r.lx - r.w / 2).toBeGreaterThanOrEqual(0);
      expect(r.ly - r.d / 2).toBeGreaterThanOrEqual(0);
      expect(r.lx + r.w / 2).toBeLessThanOrEqual(FLOOR);
      expect(r.ly + r.d / 2).toBeLessThanOrEqual(FLOOR);
    }
  });
});

describe('LEISURE_SPOTS', () => {
  it('offers five lounge seats to idle members and four standing spots to away ones (2026-10-27)', () => {
    // Three stools at the island, one couch cushion, one armchair. Away members stand small at the
    // island's east end and the café's south threshold — idle sits, away stands (spec §2.9).
    expect(LEISURE_SPOTS.filter((s) => s.zone === 'lounge' && s.sit === 1)).toHaveLength(5);
    expect(NOOK_SPOTS).toHaveLength(4);
    expect(NOOK_CAP).toBe(4);
  });

  it('keeps every pair of spots far enough apart to read as two people', () => {
    // The guard is in **screen** space, not floor space: the 2:1 iso halves the ly axis, so two spots can
    // be a comfortable 64 apart on the plan and 37 apart in pixels — one smeared avatar under two stacked
    // name labels. This is the check that keeps a spot from being added back into a pile.
    const fit = { ox: 0, oy: 0, scale: 1 };
    for (let i = 0; i < LEISURE_SPOTS.length; i++) {
      for (let j = i + 1; j < LEISURE_SPOTS.length; j++) {
        const a = LEISURE_SPOTS[i]!;
        const b = LEISURE_SPOTS[j]!;
        const pa = project(a.lx, a.ly, fit);
        const pb = project(b.lx, b.ly, fit);
        const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        expect(
          gap,
          `${a.zone}[${i}] and ${b.zone}[${j}] are ${gap.toFixed(1)} apart on screen`,
        ).toBeGreaterThanOrEqual(MIN_SPOT_GAP);
      }
    }
  });

  it('stands every away spot clear of every seat and every other spot (lane 01M5ZZ72D7)', () => {
    // An away member stands small, but their name label is full size: two spots 18 and 28 px from the
    // island stool put an away label on top of a seated one (2026-10-27).
    const fit = { ox: 0, oy: 0, scale: 1 };
    const spots = NOOK_SPOTS.map((s) => ({ lx: NOOK.lx + s.dx, ly: NOOK.ly + s.dy }));
    const gap = (a: { lx: number; ly: number }, b: { lx: number; ly: number }) => {
      const pa = project(a.lx, a.ly, fit);
      const pb = project(b.lx, b.ly, fit);
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    spots.forEach((a, i) => {
      for (const seat of LEISURE_SPOTS) {
        expect(gap(a, seat), `away[${i}] vs ${seat.zone} seat`).toBeGreaterThanOrEqual(MIN_SPOT_GAP);
      }
      spots.slice(i + 1).forEach((b, j) => {
        expect(gap(a, b), `away[${i}] vs away[${i + j + 1}]`).toBeGreaterThanOrEqual(MIN_SPOT_GAP);
      });
    });
  });

  it('offers every zone, so idle members spread instead of filling one corner', () => {
    for (const zone of ['lounge', 'waiting', 'meeting', 'reading']) {
      expect(LEISURE_SPOTS.some((s) => s.zone === zone)).toBe(true);
    }
  });

  it('interleaves zones, so a probe that collides lands in a different part of the room', () => {
    // Assignment is a hash + linear probe over this array (seating.ts). Grouped by zone, a collision
    // walks to the seat *next door* and the room clumps; interleaved, it lands across the floor.
    const firstFour = LEISURE_SPOTS.slice(0, 4).map((s) => s.zone);
    expect(new Set(firstFour).size).toBe(4);
  });

  it('keeps every spot on the floor', () => {
    for (const s of LEISURE_SPOTS) {
      expect(s.lx).toBeGreaterThan(0);
      expect(s.ly).toBeGreaterThan(0);
      expect(s.lx).toBeLessThan(FLOOR);
      expect(s.ly).toBeLessThan(FLOOR);
    }
  });
});

describe('the front desk', () => {
  it('sits near the entrance, facing arrivals', () => {
    expect(Math.hypot(FRONT_DESK.lx - ENTRANCE.lx, FRONT_DESK.ly - ENTRANCE.ly)).toBeLessThan(260);
  });

  it('does not sit on the overflow queue strip', () => {
    for (let i = 0; i < STRIP_CAP; i++) {
      const qx = ENTRANCE.lx + 34 + i * 32;
      const qy = ENTRANCE.ly - 10 - i * 6;
      const inDesk =
        Math.abs(qx - FRONT_DESK.lx) < FRONT_DESK.long / 2 &&
        Math.abs(qy - FRONT_DESK.ly) < FRONT_DESK.deep / 2;
      expect(inDesk).toBe(false);
    }
  });

  it('puts the receptionist behind the counter and the marks in front of it', () => {
    expect(CHECK_IN_MARKS.length).toBeGreaterThanOrEqual(3);
    for (const m of CHECK_IN_MARKS) {
      expect(Math.sign(m.ly - FRONT_DESK.ly)).not.toBe(Math.sign(RECEPTIONIST.ly - FRONT_DESK.ly));
    }
  });

  it('occludes the receptionist with the counter, not the other way round', () => {
    // Depth is lx+ly: the greater sum paints later, in front. A receptionist painted OVER her own
    // desk reads as standing on it.
    expect(RECEPTIONIST.lx + RECEPTIONIST.ly).toBeLessThan(FRONT_DESK.lx + FRONT_DESK.ly);
  });
});

describe('the walls are not a matched set', () => {
  it('hangs five pieces of art, varied in size and shape', () => {
    // The sixth piece was the small cairn under the clock; the working-hours calendar now owns that wall slot.
    expect(ART).toHaveLength(5);
    expect(new Set(ART.map((a) => `${a.w}x${a.h}`)).size).toBeGreaterThan(3);
    expect(ART.some((a) => a.w > a.h)).toBe(true); // landscape
    expect(ART.some((a) => a.h > a.w)).toBe(true); // portrait
    expect(ART.some((a) => a.w === a.h)).toBe(true); // square
  });

  it('varies motif and frame treatment, including one unframed', () => {
    expect(new Set(ART.map((a) => a.motif)).size).toBeGreaterThan(2);
    expect(new Set(ART.map((a) => a.frame)).size).toBeGreaterThan(1);
    expect(ART.some((a) => a.frame === 'none')).toBe(true);
  });

  it('puts art on both walls', () => {
    expect(ART.some((a) => a.wall === 0)).toBe(true);
    expect(ART.some((a) => a.wall === 1)).toBe(true);
  });

  it('never hangs a picture over a window', () => {
    // Both back walls are mostly glass, so this is the constraint that decides where art can go at
    // all — and the first cut of the salon cluster failed it, hanging three pieces across the frame
    // of the near window. Half-widths are converted to `t` the same way `wallArt` does.
    for (const a of ART) {
      const half = a.w / 2 / FLOOR;
      for (const w of WINDOWS) {
        const overlaps = a.tc + half > w.t0 && a.tc - half < w.t1;
        expect(overlaps, `art (${a.motif} on wall ${a.wall} at t=${a.tc}) overlaps a window`).toBe(
          false,
        );
      }
    }
  });

  it('never hangs a picture behind a bookshelf', () => {
    // A shelf occupies a `t` band on its wall and stands `high` units up it. If a picture shares that
    // band, its bottom edge has to clear the carcass AND whatever is standing on top of it — this
    // broke silently when the corner unit went from 66 to 88 tall and swallowed a print's lower third.
    const DECOR_UP = 22; // the tallest shelf-top object
    for (const a of ART) {
      const halfT = a.w / 2 / FLOOR;
      const bottom = a.uc * WALL_H - a.h / 2;
      for (const s of BOOKSHELVES) {
        // wall 0 is the lx=0 edge (t maps to ly); wall 1 is the ly=0 edge (t maps to lx)
        const onWall0 = s.dir === 'E';
        if ((a.wall === 0) !== onWall0) continue;
        const st = (onWall0 ? s.ly : s.lx) / FLOOR;
        const halfS = s.long / 2 / FLOOR;
        if (a.tc + halfT < st - halfS || a.tc - halfT > st + halfS) continue;
        expect(
          bottom,
          `art (${a.motif} at t=${a.tc}) hangs behind the ${s.high}-tall shelf at t=${st.toFixed(2)}`,
        ).toBeGreaterThan(s.high + DECOR_UP);
      }
    }
  });

  it('stands no shelf taller than the sill in front of a window', () => {
    // A low unit can sit under a window (the low-wide one does); one that rises past the sill covers
    // the glass. The wiki shelf ran onto the left wall's near window this way until 2026-10-28.
    for (const s of BOOKSHELVES) {
      const st = (s.dir === 'E' ? s.ly : s.lx) / FLOOR;
      const half = s.long / 2 / FLOOR;
      for (const w of WINDOWS) {
        if (s.high <= w.u0 * WALL_H) continue;
        expect(
          st + half <= w.t0 || st - half >= w.t1,
          `the ${s.high}-tall shelf (t ${(st - half).toFixed(3)}–${(st + half).toFixed(3)}) covers a window`,
        ).toBe(true);
      }
    }
  });

  it('hangs the agile board clear of every window, the clock, the art, and the wall ends', () => {
    // The board holds the whiteboard's old slot widened into the wall's free far end — these are the
    // guards that earn it a home in layout.ts (the same rules the art lives by). The clock's numbers
    // come from render.ts (`wallClock` R=25 at t 0.52): mirrored here as data because the draw call
    // doesn't export them, and drifting silently onto the clock is exactly what this test is for.
    const half = WALL_BOARD.w / 2 / FLOOR;
    const t0 = WALL_BOARD.tc - half;
    const t1 = WALL_BOARD.tc + half;
    expect(t0).toBeGreaterThan(0);
    expect(t1).toBeLessThanOrEqual(1);
    for (const w of WINDOWS) {
      expect(
        t1 <= w.t0 || t0 >= w.t1,
        `board (t ${t0.toFixed(3)}–${t1.toFixed(3)}) overlaps a window`,
      ).toBe(true);
    }
    const CLOCK = { tc: 0.52, r: 27.5 / FLOOR };
    expect(t0 > CLOCK.tc + CLOCK.r || t1 < CLOCK.tc - CLOCK.r).toBe(true);
    for (const a of ART.filter((p) => p.wall === WALL_BOARD.wall)) {
      const ah = a.w / 2 / FLOOR;
      expect(t1 <= a.tc - ah || t0 >= a.tc + ah, `board overlaps the ${a.motif} print`).toBe(true);
    }
    // Vertically: on the wall (u ∈ [0,1]), above the bookshelf line the art also respects.
    expect(WALL_BOARD.uc * WALL_H - WALL_BOARD.h / 2).toBeGreaterThan(0);
    expect(WALL_BOARD.uc * WALL_H + WALL_BOARD.h / 2).toBeLessThan(WALL_H);
  });

  it('reserves the former under-clock art slot for the compact working-hours calendar', () => {
    const half = WORKING_HOURS_CALENDAR.w / 2 / FLOOR;
    const t0 = WORKING_HOURS_CALENDAR.tc - half;
    const t1 = WORKING_HOURS_CALENDAR.tc + half;
    const u0 = WORKING_HOURS_CALENDAR.uc * WALL_H - WORKING_HOURS_CALENDAR.h / 2;
    const u1 = WORKING_HOURS_CALENDAR.uc * WALL_H + WORKING_HOURS_CALENDAR.h / 2;
    expect(WORKING_HOURS_CALENDAR.wall).toBe(1);
    expect(t0).toBeGreaterThan(0);
    expect(t1).toBeLessThan(1);
    expect(u0).toBeGreaterThan(0);
    expect(u1).toBeLessThan(WALL_H);

    const CLOCK = { tc: 0.52, r: 27.5 / FLOOR, u0: 0.62 * WALL_H - 27.5, u1: 0.62 * WALL_H + 27.5 };
    // The binder loops rise above the paper rectangle, so their physical extent—not only the card face—must clear the dial.
    const fixtureTop = u1 + WORKING_HOURS_CALENDAR.loopOverhang;
    expect(
      t0 > CLOCK.tc + CLOCK.r || t1 < CLOCK.tc - CLOCK.r || fixtureTop < CLOCK.u0 || u0 > CLOCK.u1,
    ).toBe(true);
    for (const art of ART.filter((piece) => piece.wall === WORKING_HOURS_CALENDAR.wall)) {
      const artT0 = art.tc - art.w / 2 / FLOOR;
      const artT1 = art.tc + art.w / 2 / FLOOR;
      const artU0 = art.uc * WALL_H - art.h / 2;
      const artU1 = art.uc * WALL_H + art.h / 2;
      expect(
        t1 < artT0 || t0 > artT1 || u1 < artU0 || u0 > artU1,
        `calendar overlaps ${art.motif}`,
      ).toBe(true);
    }
  });

  it('keeps the working-hours calendar inside the window bay it hangs in', () => {
    // The card fills the gap between the two windows, so its width is now bounded by them, not by taste.
    const half = WORKING_HOURS_CALENDAR.w / 2 / FLOOR;
    for (const win of WINDOWS) {
      const clearsSideways =
        WORKING_HOURS_CALENDAR.tc + half < win.t0 || WORKING_HOURS_CALENDAR.tc - half > win.t1;
      const clearsBelow =
        WORKING_HOURS_CALENDAR.uc + WORKING_HOURS_CALENDAR.h / 2 / WALL_H < win.u0;
      expect(clearsSideways || clearsBelow, `calendar overlaps a window at t${win.t0}`).toBe(true);
    }
  });

  it('does not make four copies of one window', () => {
    expect(new Set(WINDOWS.map((w) => w.mullions)).size).toBeGreaterThan(1);
    expect(WINDOWS.some((w) => w.sill)).toBe(true);
  });

  it('brightens toward one sun — a random ramp reads as broken glass, not sunlight', () => {
    const bright = WINDOWS.map((w) => w.bright);
    expect(new Set(bright).size).toBeGreaterThan(1);
    expect([...bright]).toEqual([...bright].sort((a, b) => b - a));
  });
});

describe('BOOKSHELVES — flush to floor edges', () => {
  it('pins each shelf so its back sits on the perimeter (door-flush pattern)', () => {
    for (const s of BOOKSHELVES) {
      // Per-shelf depth: the units are no longer one repeated box, so "flush" is measured against
      // each unit's own footprint rather than a shared constant.
      const half = s.deep / 2;
      switch (s.dir) {
        case 'S':
          expect(s.ly).toBe(half);
          break;
        case 'N':
          expect(s.ly).toBe(FLOOR - half);
          break;
        case 'E':
          expect(s.lx).toBe(half);
          break;
        case 'W':
          expect(s.lx).toBe(FLOOR - half);
          break;
        default: {
          const _exhaustive: never = s.dir;
          throw new Error(`unexpected dir ${_exhaustive}`);
        }
      }
    }
  });

  it('is not a matched set — the units differ in size', () => {
    expect(new Set(BOOKSHELVES.map((s) => s.long)).size).toBeGreaterThan(1);
    expect(new Set(BOOKSHELVES.map((s) => s.high)).size).toBeGreaterThan(1);
  });

  it('scales the band count with the height, so a low unit is not a tall one squashed', () => {
    const byHeight = [...BOOKSHELVES].sort((a, b) => a.high - b.high);
    expect(byHeight[0]!.rows).toBeLessThan(byHeight[byHeight.length - 1]!.rows);
  });

  it('has none shelved backwards since the right-wall unit went (2026-10-27)', () => {
    expect(BOOKSHELVES.filter((s) => s.reversed)).toHaveLength(0);
  });

  it('gives every unit something for its top', () => {
    for (const s of BOOKSHELVES) expect(s.decor).toBeTruthy();
  });
});

describe('the reception counter keeps its own floor', () => {
  // nick, 2026-10-27 (screenshot): "a desk that is on top of half of the reception desk" — pod 2's
  // bottom zigzag step, facing E, ran its slab 30 units into the counter.
  it('no desk slab overlaps the front desk', () => {
    const fx0 = FRONT_DESK.lx - FRONT_DESK.long / 2;
    const fx1 = FRONT_DESK.lx + FRONT_DESK.long / 2;
    const fy0 = FRONT_DESK.ly - FRONT_DESK.deep / 2;
    const fy1 = FRONT_DESK.ly + FRONT_DESK.deep / 2;
    for (const s of DESK_SLOTS) {
      const ew = s.dir === 'E' || s.dir === 'W';
      const { w, d } = deskDims(s);
      const hw = (ew ? d : w) / 2;
      const hd = (ew ? w : d) / 2;
      const overlaps = s.lx - hw < fx1 && s.lx + hw > fx0 && s.ly - hd < fy1 && s.ly + hd > fy0;
      expect(overlaps, `desk ${s.id} at (${s.lx},${s.ly}) sits on the front desk`).toBe(false);
    }
  });
});

describe('the café keeps everything on its tile (nick, 2026-10-27)', () => {
  const inside = (x0: number, y0: number, x1: number, y1: number): boolean =>
    x0 >= CAFE.x0 && x1 <= CAFE.x1 && y0 >= CAFE.y0 && y1 <= CAFE.y1;
  const at = (dx: number, dy: number, w: number, d: number) =>
    inside(NOOK.lx + dx - w / 2, NOOK.ly + dy - d / 2, NOOK.lx + dx + w / 2, NOOK.ly + dy + d / 2);
  it('the fridge, counter, cooler, island, stools, couch, table and the café armchairs stand on the tile', () => {
    const L = LOUNGE;
    expect(at(L.fridge.dx, L.fridge.dy, L.fridge.w, L.fridge.d), 'fridge').toBe(true);
    expect(at(L.counter.dx, L.counter.dy, L.counter.w, L.counter.d), 'counter').toBe(true);
    expect(at(L.cooler.dx, L.cooler.dy, L.cooler.w, L.cooler.d), 'cooler').toBe(true);
    expect(at(L.island.dx, L.island.dy, L.island.w, L.island.d), 'island').toBe(true);
    for (const st of L.stools) expect(at(st.dx, st.dy, STOOL, STOOL), 'stool').toBe(true);
    expect(at(L.couch.dx, L.couch.dy, L.couch.len, L.couch.dep), 'couch').toBe(true);
    expect(at(L.table.dx, L.table.dy, L.table.w, L.table.d), 'table').toBe(true);
    for (const a of L.armchairs.slice(0, 2)) expect(at(a.dx, a.dy, WAIT_CHAIR, WAIT_CHAIR), 'armchair').toBe(true);
    // and the fridge a full step in from the tile's west edge, not on the line (nick, 2026-10-27)
    expect(NOOK.lx + L.fridge.dx - L.fridge.w / 2).toBeGreaterThanOrEqual(CAFE.x0 + 30);
  });
});

describe('desk sizes', () => {
  it('the spine desks are the compact size; every other desk is the standard one', () => {
    for (const s of DESK_SLOTS) {
      const dims = deskDims(s);
      if (s.kind === 'pod' && PODS[s.pod]!.shape === 'spine') expect(dims).toEqual(DESK_COMPACT);
      else expect(dims).toEqual({ w: DESK_W, d: DESK_D });
    }
    expect(DESK_COMPACT.w).toBeLessThan(DESK_W);
    expect(DESK_COMPACT.d).toBeLessThan(DESK_D);
  });
});

describe('scene.py mirrors the café it renders', () => {
  // The counter and island sprites are built at scene.py's own copy of LOUNGE. When that copy drifts,
  // the picture and the nav disagree: on 2026-10-27 the island drew 130 wide over a 60-wide footprint
  // and looked as if it ran under the fridge. Pin the sizes the sprites bake in.
  const py = readFileSync(new URL('../../../art/office/scene.py', import.meta.url), 'utf8');
  const num = (re: RegExp): number => Number(py.match(re)![1]);
  it('island and counter sizes, and the fixtures the counter sprite bakes in', () => {
    expect(num(/island=dict\(dx=(-?\d+)/)).toBe(LOUNGE.island.dx);
    expect(num(/island=dict\([^)]*\bw=(\d+)/)).toBe(LOUNGE.island.w);
    expect(num(/counter=dict\(dx=(-?\d+)/)).toBe(LOUNGE.counter.dx);
    expect(num(/counter=dict\([^)]*\bw=(\d+)/)).toBe(LOUNGE.counter.w);
    expect(num(/machine=dict\(dx=(-?\d+)/)).toBe(LOUNGE.machine.dx);
    expect(num(/sink=dict\(dx=(-?\d+)/)).toBe(SINK.dx);
    expect(num(/fridge=dict\(dx=(-?\d+)/)).toBe(LOUNGE.fridge.dx);
    expect(num(/cooler=dict\(dx=(-?\d+)/)).toBe(LOUNGE.cooler.dx);
  });
});
