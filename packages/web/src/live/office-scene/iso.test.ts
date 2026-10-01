import { describe, expect, it } from 'vitest';
import { fitFloor } from './iso';

describe('fitFloor', () => {
  it('a zoom multiplies the scale and keeps the room centred on the panel', () => {
    const base = fitFloor(1519, 1080);
    const zoomed = fitFloor(1519, 1080, 1.09);
    expect(zoomed.scale).toBeCloseTo(base.scale * 1.09, 6);
    expect(zoomed.ox).toBe(base.ox);
    // Centred vertically too: the box grows by the same amount above and below the panel's middle,
    // so the back corner (oy) moves up by exactly half the extra height that rises above it.
    const mid = 1080 / 2;
    expect((zoomed.oy - mid) / (base.oy - mid)).toBeCloseTo(1.09, 6);
  });

  it('defaults to the whole room (zoom 1) — /live is unchanged', () => {
    expect(fitFloor(1519, 1080, 1)).toEqual(fitFloor(1519, 1080));
  });
});
