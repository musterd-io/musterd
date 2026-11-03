import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FLOOR, WALL_H, type Fit } from './iso';
import {
  ART,
  DRAPE_REACH,
  WALL_BOARD,
  WINDOW_TREATMENT,
  WINDOWS,
  WORKING_HOURS_CALENDAR,
} from './layout';
import { SIGN_NAMES, SIGNS, signRect } from './signs';
import { WALL_EDGES, wallPt } from './windowView';

type Box = { wall: 0 | 1; t0: number; t1: number; u0: number; u1: number };
const box = (o: { wall: 0 | 1; tc: number; uc: number; w: number; h: number }): Box => ({
  wall: o.wall,
  t0: o.tc - o.w / 2 / FLOOR,
  t1: o.tc + o.w / 2 / FLOOR,
  u0: o.uc - o.h / 2 / WALL_H,
  u1: o.uc + o.h / 2 / WALL_H,
});
const overlaps = (a: Box, b: Box): boolean =>
  a.wall === b.wall && a.t0 < b.t1 && b.t0 < a.t1 && a.u0 < b.u1 && b.u0 < a.u1;

describe('the signs', () => {
  it('hang clear of every window and its treatment', () => {
    for (const name of SIGN_NAMES) {
      const s = box(SIGNS[name]);
      const reach = WINDOW_TREATMENT[s.wall] === 'drapes' ? DRAPE_REACH : 0;
      for (const w of WINDOWS) {
        expect(s.t1 <= w.t0 - reach || s.t0 >= w.t1 + reach, `${name} sign on a window`).toBe(true);
      }
    }
  });

  it('hang clear of the paintings, the clock, the calendar and the board', () => {
    const clock: Box = box({ wall: 1, tc: 0.52, uc: 0.62, w: 55, h: 55 });
    const others: Array<[string, Box]> = [
      ...ART.map((a): [string, Box] => [a.painting, box(a)]),
      ['clock', clock],
      ['calendar', box(WORKING_HOURS_CALENDAR)],
      ['board', box(WALL_BOARD)],
    ];
    for (const name of SIGN_NAMES) {
      for (const [what, o] of others) {
        expect(overlaps(box(SIGNS[name]), o), `${name} sign overlaps the ${what}`).toBe(false);
      }
    }
  });

  it('match the copy scene.py renders them from', () => {
    const py = readFileSync(new URL('../../../art/office/scene.py', import.meta.url), 'utf8');
    for (const name of SIGN_NAMES) {
      const s = SIGNS[name];
      const m = py.match(new RegExp(`"${name}": \\((\\d), ([\\d.]+), ([\\d.]+), (\\d+), (\\d+), "([^"]+)", (True|False)\\)`));
      expect(m, `scene.py SIGNS has no ${name}`).not.toBeNull();
      expect([Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4]), Number(m![5]), m![6], m![7] === 'True']).toEqual([
        s.wall,
        s.tc,
        s.uc,
        s.w,
        s.h,
        s.text,
        s.lamp,
      ]);
    }
  });
});

describe('signRect', () => {
  for (const scale of [0.6, 1.4]) {
    const fit: Fit = { ox: 400, oy: 300, scale };
    for (const name of SIGN_NAMES) {
      it(`covers the ${name} sign and is a 24px target at scale ${scale}`, () => {
        const s = SIGNS[name];
        const r = signRect(fit, name);
        expect(r.w).toBeGreaterThanOrEqual(24);
        expect(r.h).toBeGreaterThanOrEqual(24);
        const b = box(s);
        for (const [t, u] of [
          [b.t0, b.u0],
          [b.t1, b.u0],
          [b.t1, b.u1],
          [b.t0, b.u1],
        ] as const) {
          const p = wallPt(WALL_EDGES[s.wall]!, t, u, fit);
          expect(p.x).toBeGreaterThanOrEqual(r.x - 1e-6);
          expect(p.x).toBeLessThanOrEqual(r.x + r.w + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(r.y - 1e-6);
          expect(p.y).toBeLessThanOrEqual(r.y + r.h + 1e-6);
        }
      });
    }
  }
});
