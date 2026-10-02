import { describe, expect, it } from 'vitest';
import { DREAM_LAMP, dreamBubble } from './render';

describe('a dreaming seat (goal dreaming, lane 5)', () => {
  it('turns its lamp down rather than off', () => {
    expect(DREAM_LAMP).toBeGreaterThan(0);
    expect(DREAM_LAMP).toBeLessThan(1);
  });

  it('floats gently and stays bounded', () => {
    for (let t = 0; t < 10; t += 0.1) {
      const { bob, dots } = dreamBubble(t);
      expect(Math.abs(bob)).toBeLessThanOrEqual(1.6);
      for (const a of dots) {
        expect(a).toBeGreaterThanOrEqual(0.35);
        expect(a).toBeLessThanOrEqual(0.9);
      }
    }
  });

  // The thought rises: across one breath the brightest dot moves head → cloud, never backwards.
  it('lights the trail dots one after another, from the head up', () => {
    const brightest = (t: number) => {
      const { dots } = dreamBubble(t);
      return dots.indexOf(Math.max(...dots));
    };
    expect([0, 1.1, 2.2].map(brightest)).toEqual([0, 1, 2]);
  });

  it('is the same at the same time, so a cached frame never jumps', () => {
    expect(dreamBubble(4.2)).toEqual(dreamBubble(4.2));
    // Negative scene time (a clock reset) wraps into the same breath rather than going NaN.
    expect(dreamBubble(-1).bob).toBeCloseTo(dreamBubble(-1 + 3.2).bob, 9);
  });
});
