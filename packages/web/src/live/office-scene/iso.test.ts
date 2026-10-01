import { describe, expect, it } from 'vitest';
import { FLOOR, KX, KY, SCENE_DROP, SCENE_RISE, fitBox, fitFloor, project } from './iso';

describe('fitFloor', () => {
  it('is exactly the whole-room fit it always was (the hero and /office-preview rely on it)', () => {
    // The pre-2026-10-01 formula, written out: scale off the whole box, centred on the panel.
    const old = (w: number, h: number) => {
      const projW = FLOOR * KX * 2;
      const projH = SCENE_RISE + FLOOR * KY * 2 + SCENE_DROP;
      const scale = Math.max(0.05, Math.min((w * 0.96) / projW, (h * 0.96) / projH));
      return { ox: w / 2, oy: (h - projH * scale) / 2 + SCENE_RISE * scale, scale };
    };
    for (const [w, h] of [[1519, 1080], [1200, 900], [390, 500], [2400, 700]] as const) {
      const a = fitFloor(w, h);
      const b = old(w, h);
      expect(a.scale).toBeCloseTo(b.scale, 9);
      expect(a.ox).toBeCloseTo(b.ox, 9);
      expect(a.oy).toBeCloseTo(b.oy, 9);
    }
  });
});

describe('fitBox', () => {
  it('centres the box on the panel, whichever axis binds', () => {
    const box = { left: -500, right: 300, top: -100, bottom: 500 };
    for (const [w, h] of [[1600, 900], [600, 1200]] as const) {
      const fit = fitBox(w, h, box, 1);
      const tl = { x: fit.ox + box.left * fit.scale, y: fit.oy + box.top * fit.scale };
      const br = { x: fit.ox + box.right * fit.scale, y: fit.oy + box.bottom * fit.scale };
      expect((tl.x + br.x) / 2).toBeCloseTo(w / 2, 6);
      expect((tl.y + br.y) / 2).toBeCloseTo(h / 2, 6);
      // …and touches the panel on the binding axis, inside it on the other.
      const fillsW = Math.abs(br.x - tl.x - w) < 1e-6;
      const fillsH = Math.abs(br.y - tl.y - h) < 1e-6;
      expect(fillsW || fillsH).toBe(true);
      expect(br.x - tl.x).toBeLessThanOrEqual(w + 1e-6);
      expect(br.y - tl.y).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('box coordinates are relative to the back corner, where project(0, 0) lands', () => {
    const fit = fitBox(1000, 800, { left: -10, right: 10, top: -10, bottom: 10 });
    expect(project(0, 0, fit)).toEqual({ x: fit.ox, y: fit.oy });
  });
});
