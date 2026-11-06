import { describe, expect, it } from 'vitest';
import { makeFrameProfile, prefixedProfile, profileSnapshot } from './frameProfile';

describe('the broadcast frame profile (lane 01M6S5V5DY)', () => {
  it('adds each stretch to the stage that ends it', () => {
    let t = 0;
    const p = makeFrameProfile(() => t);
    p.begin();
    t = 3;
    p.mark('shell');
    t = 10;
    p.mark('walls');
    t = 11;
    p.mark('shell');
    expect(p.totals).toEqual({ shell: 4, walls: 7 });
  });

  it('begin drops the time before it, so idle time between frames lands in no stage', () => {
    let t = 0;
    const p = makeFrameProfile(() => t);
    t = 500;
    p.begin();
    t = 502;
    p.mark('items');
    expect(p.totals).toEqual({ items: 2 });
  });

  it('a snapshot is a rounded copy, not the live totals', () => {
    let t = 0;
    const p = makeFrameProfile(() => t);
    t = 1.234;
    p.mark('light');
    const s = profileSnapshot(p.totals);
    expect(s).toEqual({ light: 1.2 });
    t = 5;
    p.mark('light');
    expect(s).toEqual({ light: 1.2 });
  });

  it('add folds in a span measured elsewhere without moving the clock', () => {
    let t = 0;
    const p = makeFrameProfile(() => t);
    p.add('frame', 33);
    t = 2;
    p.mark('sim');
    expect(p.totals).toEqual({ frame: 33, sim: 2 });
  });
});

describe('the measure pass profile', () => {
  it('prefixes every stage and shares the clock and totals', () => {
    let t = 0;
    const p = makeFrameProfile(() => t);
    const m = prefixedProfile(p, 'm.');
    t = 4;
    m.mark('walls');
    t = 5;
    p.mark('measure');
    m.frames++;
    expect(p.totals).toEqual({ 'm.walls': 4, measure: 1 });
    expect(p.frames).toBe(1);
  });
});
