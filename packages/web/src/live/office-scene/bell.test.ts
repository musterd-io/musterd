import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BELL, BELL_SWING_S, bellPivot, bellSwing, ROPE, wallTurn } from './bell';
import { FLOOR, WALL_H, type Fit } from './iso';
import { WALL_BOARD, WINDOWS } from './layout';
import { SIGNS } from './signs';

const boardT0 = WALL_BOARD.tc - WALL_BOARD.w / 2 / FLOOR;

describe('the goal bell', () => {
  it('hangs on the board wall, in the plaster between the last window and the board', () => {
    expect(BELL.wall).toBe(WALL_BOARD.wall);
    const half = BELL.r / FLOOR;
    expect(BELL.tc - half).toBeGreaterThan(WINDOWS[WINDOWS.length - 1]!.t1);
    expect(BELL.tc + half).toBeLessThan(boardT0);
  });

  it('keeps its rope off the board: in front of the wall it lands screen-left, away from the frame', () => {
    expect(BELL.tc).toBeLessThan(boardT0);
    expect(ROPE.uTop).toBeGreaterThan(ROPE.uBottom);
    expect(ROPE.uBottom * WALL_H).toBeGreaterThan(50); // hand height for a standing member, not the floor
  });

  it('hangs clear of the work-board sign and above the board', () => {
    const lip = BELL.pivotU * WALL_H - BELL.h;
    expect(lip).toBeGreaterThan(WALL_BOARD.uc * WALL_H + WALL_BOARD.h / 2);
    expect(BELL.tc + BELL.r / FLOOR).toBeLessThan(SIGNS.board.tc - SIGNS.board.w / 2 / FLOOR);
    expect(BELL.pivotU * WALL_H + 4).toBeLessThan(WALL_H);
  });

  it('swings from the strike and is still by the end of the ring', () => {
    expect(bellSwing(-1)).toBe(0);
    expect(bellSwing(0)).toBeCloseTo(0, 6);
    expect(Math.abs(bellSwing(0.15))).toBeGreaterThan(0.2);
    expect(Math.abs(bellSwing(0.15))).toBeLessThanOrEqual(0.35);
    expect(Math.abs(bellSwing(BELL_SWING_S - 0.01))).toBeLessThan(0.02);
    expect(bellSwing(BELL_SWING_S)).toBe(0);
    expect(Math.abs(bellSwing(0.15, 0.08))).toBeLessThanOrEqual(0.08);
  });

  it('turns about its pivot: the pivot stays put and no angle is the identity', () => {
    const fit: Fit = { ox: 300, oy: 200, scale: 1.2 };
    const p = bellPivot(fit);
    const still = wallTurn(fit, p, 0);
    expect(still.a).toBeCloseTo(1, 9);
    expect(still.d).toBeCloseTo(1, 9);
    expect(still.b).toBeCloseTo(0, 9);
    expect(still.c).toBeCloseTo(0, 9);
    const m = wallTurn(fit, p, 0.3);
    expect(m.a! * p.x + m.c! * p.y + m.e!).toBeCloseTo(p.x, 6);
    expect(m.b! * p.x + m.d! * p.y + m.f!).toBeCloseTo(p.y, 6);
  });

  it('matches the copy scene.py renders it from', () => {
    const py = readFileSync(new URL('../../../art/office/scene.py', import.meta.url), 'utf8');
    const m = py.match(/^BELL = \((\d), ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/m);
    expect(m).not.toBeNull();
    expect(m!.slice(1).map(Number)).toEqual([BELL.wall, BELL.tc, BELL.pivotU, BELL.out, BELL.r, BELL.h]);
  });
});
