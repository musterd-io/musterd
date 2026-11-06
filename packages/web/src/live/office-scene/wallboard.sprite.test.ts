import { describe, expect, it } from 'vitest';
import { boardKey, boardSwaying, STICKY_SWAY_S, type WallBoard, type WallSticky } from './wallboard';

/** Lane 01M6S5V5DY: a still board blits as one sprite keyed on what it shows. */
const sticky = (over: Partial<WallSticky> = {}): WallSticky => ({
  seed: 7,
  state: 'active',
  row: 0,
  x: 0.5,
  y: 0.5,
  at: 1,
  ...over,
});
function board(stickies: WallSticky[], extra: Partial<WallBoard> = {}): WallBoard {
  const b = [{ stickies }, { stickies: [] }] as unknown as WallBoard;
  return Object.assign(b, extra);
}

describe('a still wall board', () => {
  it('is swaying only while a card is inside its landing swing', () => {
    expect(boardSwaying(null)).toBe(false);
    expect(boardSwaying(board([sticky()]))).toBe(false);
    expect(boardSwaying(board([sticky({ age: 0.2 })]))).toBe(true);
    expect(boardSwaying(board([sticky({ age: STICKY_SWAY_S })]))).toBe(false);
  });

  it('keys on what the painter reads, ignoring age', () => {
    const a = boardKey(board([sticky({ age: 3 })]));
    const b = boardKey(board([sticky({ age: 9 })]));
    expect(a).toBe(b);
    expect(boardKey(board([sticky({ x: 0.6 })]))).not.toBe(boardKey(board([sticky()])));
    expect(boardKey(board([sticky({ taken: true })]))).not.toBe(boardKey(board([sticky()])));
  });

  it('carries the rows and reads the array itself would drop', () => {
    const plain = boardKey(board([sticky()]));
    expect(boardKey(board([sticky()], { reads: ['overdue'] }))).not.toBe(plain);
    expect(boardKey(board([sticky()], { rows: [{ goalId: 'g', label: 'g', tone: 0 }] }))).not.toBe(plain);
  });

  it('is built once per board object', () => {
    const b = board([sticky()]);
    expect(boardKey(b)).toBe(boardKey(b));
  });
});
