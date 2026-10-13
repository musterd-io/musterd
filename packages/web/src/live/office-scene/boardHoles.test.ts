import { describe, expect, it } from 'vitest';
import { loadHeld, saveHeld } from './boardHoles';
import { STICKY_CAP } from './wallboard';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('boardHoles — a viewer\'s pin-hole history in browser storage (lane 01M4VP3V99)', () => {
  it('round-trips the marks per team, so a reload keeps the holes', () => {
    const s = memory();
    saveHeld('revive', { done: 3, active: 1 }, s);
    expect(loadHeld('revive', s)).toEqual({ done: 3, active: 1 });
    expect(loadHeld('another-team', s)).toEqual({});
  });

  it('reads nothing back it should not trust', () => {
    const s = memory();
    s.setItem('musterd.live.board-held.v1.revive', JSON.stringify({ done: 99, active: -1, blocked: 1.5, nonsense: 2, open: 'x' }));
    expect(loadHeld('revive', s)).toEqual({ done: STICKY_CAP }); // capped; negatives, fractions, unknown columns and strings dropped
    s.setItem('musterd.live.board-held.v1.revive', '{not json');
    expect(loadHeld('revive', s)).toEqual({});
    s.setItem('musterd.live.board-held.v1.revive', '7');
    expect(loadHeld('revive', s)).toEqual({});
  });

  it('degrades to no holes, never an error, when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadHeld('revive', broken)).toEqual({});
    expect(() => saveHeld('revive', { done: 2 }, broken)).not.toThrow();
    expect(loadHeld('revive', null)).toEqual({});
    expect(() => saveHeld('revive', { done: 2 }, null)).not.toThrow();
  });
});
