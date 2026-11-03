import { describe, expect, it } from 'vitest';

import { DESK_GLOW_S, deskGlowAlpha, drawDeskGlow } from './deskGlow';
import { recordingCtx } from './recording-ctx';

describe('deskGlowAlpha', () => {
  it('is dark before the lane closes and after the glow ends', () => {
    expect(deskGlowAlpha(-0.1)).toBe(0);
    expect(deskGlowAlpha(DESK_GLOW_S)).toBe(0);
    expect(deskGlowAlpha(5)).toBe(0);
  });
  it('peaks at 0.5 a fifth of a second in, then only fades', () => {
    expect(deskGlowAlpha(0.2)).toBeCloseTo(0.5, 5);
    let last = deskGlowAlpha(0.2);
    for (let s = 0.3; s < DESK_GLOW_S; s += 0.1) {
      const a = deskGlowAlpha(s);
      expect(a).toBeLessThan(last);
      last = a;
    }
  });
});

describe('drawDeskGlow', () => {
  it('draws nothing at zero', () => {
    const { ctx, ops } = recordingCtx();
    drawDeskGlow(ctx, { x: 0, y: 0 }, 1, 0);
    expect(ops).toEqual([]);
  });
  it('adds light, never covers', () => {
    const { ctx, ops } = recordingCtx();
    drawDeskGlow(ctx, { x: 10, y: 10 }, 1, 0.4);
    expect(ops).toContainEqual({ name: 'set:globalCompositeOperation', args: ['lighter'] });
    expect(ops.map((o) => o.name)).toContain('fill');
  });
});
