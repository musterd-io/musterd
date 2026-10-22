import { describe, expect, it } from 'vitest';
import { cellIndex, DIR8, dir8FromDir, dir8FromHeading, frameCell, frameRect, type SheetSpec } from './figureSheet';

const spec: SheetSpec = {
  scale: 3,
  frame: { w: 64, h: 96 },
  anchor: { x: 32, y: 88 },
  anims: {
    idle: { row: 0, frames: 8, fps: 12, loop: true },
    walk: { row: 8, frames: 6, fps: 12, loop: true },
    'sit-type': { row: 16, frames: 6, fps: 12, loop: true },
    'sit-idle': { row: 24, frames: 8, fps: 12, loop: true },
    speak: { row: 32, frames: 8, fps: 12, loop: true },
    turn: { row: 40, frames: 4, fps: 12, loop: false },
    'sit-down': { row: 48, frames: 6, fps: 12, loop: false },
    'stand-up': { row: 56, frames: 6, fps: 12, loop: false },
  },
};

describe('dir8FromHeading (office realism Task 10)', () => {
  it('reads the heading the way character.ts does: 0 is E, π/2 is S (y down)', () => {
    expect(dir8FromHeading(0)).toBe('E');
    expect(dir8FromHeading(Math.PI / 2)).toBe('S');
    expect(dir8FromHeading(Math.PI)).toBe('W');
    expect(dir8FromHeading(-Math.PI / 2)).toBe('N');
    expect(dir8FromHeading(Math.PI / 4)).toBe('SE');
    expect(dir8FromHeading((-3 * Math.PI) / 4)).toBe('NW');
    expect(dir8FromHeading(2 * Math.PI + 0.01)).toBe('E'); // any winding
  });

  it('holds the previous direction within ±4° of a boundary, flips past it (Review Focus 4)', () => {
    const edge = Math.PI / 8; // the E|SE boundary
    const deg = Math.PI / 180;
    expect(dir8FromHeading(edge + 1 * deg, 'E')).toBe('E');
    expect(dir8FromHeading(edge + 3.9 * deg, 'E')).toBe('E');
    expect(dir8FromHeading(edge + 5 * deg, 'E')).toBe('SE');
    expect(dir8FromHeading(edge - 1 * deg, 'SE')).toBe('SE');
    expect(dir8FromHeading(edge - 5 * deg, 'SE')).toBe('E');
    // without a previous direction the boundary is sharp
    expect(dir8FromHeading(edge + 1 * deg)).toBe('SE');
    // a previous direction that is not adjacent gives no hysteresis
    expect(dir8FromHeading(edge + 1 * deg, 'N')).toBe('SE');
  });

  it('never flickers across a slow sweep: each step changes by at most one sector', () => {
    let prev = dir8FromHeading(0);
    for (let i = 1; i <= 720; i++) {
      const cur = dir8FromHeading((i / 720) * 2 * Math.PI + Math.sin(i) * 0.02, prev);
      const d = Math.abs(DIR8.indexOf(cur) - DIR8.indexOf(prev));
      expect(Math.min(d, 8 - d)).toBeLessThanOrEqual(1);
      prev = cur;
    }
  });

  it('maps the four cardinals', () => {
    expect(dir8FromDir('E')).toBe('E');
    expect(dir8FromDir('S')).toBe('S');
    expect(dir8FromDir('W')).toBe('W');
    expect(dir8FromDir('N')).toBe('N');
  });
});

describe('frameRect', () => {
  it('a 6-frame 12 fps loop at 0.5 s is frame 0 again, not done', () => {
    const r = frameRect(spec, 'walk', 'E', 10.5, 10);
    expect(r).toEqual({ sx: 0, sy: (8 + DIR8.indexOf('E')) * 96, sw: 64, sh: 96, done: false });
    expect(frameRect(spec, 'walk', 'E', 10 + 1 / 12, 10).sx).toBe(64);
    expect(frameRect(spec, 'walk', 'E', 10 + 5 / 12, 10).sx).toBe(5 * 64);
  });

  it('a 4-frame one-shot at 1.0 s is its last frame, done', () => {
    const r = frameRect(spec, 'turn', 'SW', 1, 0);
    expect(r.sx).toBe(3 * 64);
    expect(r.sy).toBe((40 + DIR8.indexOf('SW')) * 96);
    expect(r.done).toBe(true);
    expect(frameRect(spec, 'turn', 'SW', 0.1, 0).done).toBe(false);
  });

  it('a clock before startT is frame 0', () => {
    expect(frameRect(spec, 'idle', 'N', 4, 5).sx).toBe(0);
  });
});

describe('packed atlas cells (frameCell)', () => {
  it('indexes ANIMS order, then DIR8, then frame', () => {
    expect(cellIndex(spec, 'idle', 'E', 0)).toBe(0);
    expect(cellIndex(spec, 'idle', 'SE', 2)).toBe(8 + 2);
    expect(cellIndex(spec, 'walk', 'E', 0)).toBe(8 * 8); // after idle's 8 frames × 8 directions
    expect(cellIndex(spec, 'walk', 'S', 5)).toBe(64 + 2 * 6 + 5);
  });

  it('reads the cell rect and offset, and an all-zero cell means nothing to draw', () => {
    const cells: number[] = new Array(8 * 8 * 6 + 6 * 8 * 6).fill(0);
    const at = cellIndex(spec, 'walk', 'S', 5) * 6;
    cells.splice(at, 6, 300, 40, 22, 31, 20, 60);
    const packed: SheetSpec = { ...spec, cells: { 'acc/glasses': cells } };
    const c = frameCell(packed, 'acc/glasses', 'walk', 'S', 10 + 5 / 12, 10);
    expect(c).toEqual({ sx: 300, sy: 40, sw: 22, sh: 31, ox: 20, oy: 60, done: false });
    expect(frameCell(packed, 'acc/glasses', 'walk', 'S', 10, 10).sw).toBe(0);
    // a layer with no cells, or a spec without them, is the grid frame at offset 0
    expect(frameCell(packed, 'skin', 'walk', 'S', 10 + 5 / 12, 10)).toEqual({ ...frameRect(spec, 'walk', 'S', 10 + 5 / 12, 10), ox: 0, oy: 0 });
  });
});

describe('mirrored directions (increment 3b: S, W and SW are drawn, not stored)', () => {
  it('a mirrored direction reads its source cell, flipped about the frame centre', () => {
    const anims = {
      idle: { row: 0, frames: 1, fps: 12, loop: true },
      walk: { row: 8, frames: 1, fps: 12, loop: true },
      'sit-type': { row: 16, frames: 1, fps: 12, loop: true },
      'sit-idle': { row: 24, frames: 1, fps: 12, loop: true },
      speak: { row: 32, frames: 1, fps: 12, loop: true },
      turn: { row: 40, frames: 1, fps: 12, loop: false },
      'sit-down': { row: 48, frames: 1, fps: 12, loop: false },
      'stand-up': { row: 56, frames: 1, fps: 12, loop: false },
    };
    // idle × DIR8 (E, SE, S, SW, W, NW, N, NE): E at atlas (10, 20), 30 wide, 5 in from the frame's left
    const idle = [10, 20, 30, 40, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const spec: SheetSpec = {
      scale: 2,
      frame: { w: 100, h: 200 },
      anchor: { x: 50, y: 190 },
      anims,
      cells: { skin: idle },
      mirror: { S: 'E', W: 'N', SW: 'NE' },
    };
    const e = frameCell(spec, 'skin', 'idle', 'E', 0, 0);
    const s = frameCell(spec, 'skin', 'idle', 'S', 0, 0);
    expect(e.flip).toBeUndefined();
    expect(s).toMatchObject({ sx: 10, sy: 20, sw: 30, sh: 40, ox: 100 - 5 - 30, oy: 6, flip: true });
  });
});

describe('carrying clips store only the layers they change (plan Task 16)', () => {
  const carrying: SheetSpec = {
    ...spec,
    anims: { ...spec.anims, 'walk-hold2': { row: 64, frames: 6, fps: 12, loop: true, base: 'walk', layers: ['skin', 'top/', 'carry/'] } },
  };
  const n = (8 * 8 + 6 * 8 + 6 * 8 + 8 * 8 + 8 * 8 + 4 * 8 + 6 * 8 + 6 * 8 + 6 * 8) * 6;
  const withCell = (anim: 'walk' | 'walk-hold2', rect: number[]) => {
    const cells: number[] = new Array(n).fill(0);
    cells.splice(cellIndex(carrying, anim, 'SE', 2) * 6, 6, ...rect);
    return cells;
  };

  it('a layer the clip does not store plays the same frame of the base clip', () => {
    const packed: SheetSpec = { ...carrying, cells: { 'hair/bob': withCell('walk', [7, 8, 9, 10, 1, 2]) } };
    expect(frameCell(packed, 'hair/bob', 'walk-hold2', 'SE', 0, 0, 2)).toMatchObject({ sx: 7, sy: 8, sw: 9, sh: 10, ox: 1, oy: 2 });
  });

  it('a layer it stores (by prefix: every top) reads its own cells', () => {
    const packed: SheetSpec = { ...carrying, cells: { 'top/tee': withCell('walk-hold2', [3, 4, 5, 6, 0, 0]) } };
    expect(frameCell(packed, 'top/tee', 'walk-hold2', 'SE', 0, 0, 2)).toMatchObject({ sx: 3, sw: 5 });
  });
});
