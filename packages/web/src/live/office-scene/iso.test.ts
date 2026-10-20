import { describe, expect, it } from 'vitest';
import {
  CORNER_CAMERA,
  FLOOR,
  ISO_CAMERA,
  KX,
  KY,
  ROOM_BOX,
  SCENE_DROP,
  SCENE_RISE,
  fitBox,
  fitFloor,
  project,
  roomBox,
} from './iso';

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

describe('Camera (office realism Task 5: the corner camera behind ?office=rendered)', () => {
  it('a Fit without a camera projects exactly as it always did', () => {
    const fit = { ox: 100, oy: 50, scale: 2 };
    expect(project(900, 0, fit)).toEqual({ x: 100 + 900 * KX * 2, y: 50 + 900 * KY * 2 });
    expect(project(300, 500, fit)).toEqual({ x: 100 + (300 - 500) * KX * 2, y: 50 + 800 * KY * 2 });
    expect(ISO_CAMERA).toEqual({ kx: KX, ky: KY });
  });

  it('a Fit carrying the corner camera projects through it', () => {
    const fit = { ox: 100, oy: 50, scale: 2, cam: CORNER_CAMERA };
    expect(project(900, 0, fit)).toEqual({
      x: 100 + 900 * CORNER_CAMERA.kx * 2,
      y: 50 + 900 * CORNER_CAMERA.ky * 2,
    });
  });

  it('the corner camera is a touch lower than isometric and still a 45° corner view', () => {
    // Azimuth stays 45° — Blender renders with a square pixel, so kx is cos 45° for every camera.
    expect(CORNER_CAMERA.kx).toBeCloseTo(KX, 8);
    // "Lower than today": a smaller elevation foreshortens the floor more, so ky drops.
    expect(CORNER_CAMERA.ky).toBeLessThan(KY);
    expect(CORNER_CAMERA.ky).toBeGreaterThan(0);
  });

  it('roomBox(ISO_CAMERA) is ROOM_BOX, and the corner camera keeps the whole floor in the panel', () => {
    expect(roomBox(ISO_CAMERA)).toEqual(ROOM_BOX);
    expect(roomBox()).toEqual(ROOM_BOX);
    for (const [w, h] of [[1100, 640], [1920, 1080]] as const) {
      const fit = fitBox(w, h, roomBox(CORNER_CAMERA), 0.96, CORNER_CAMERA);
      expect(fit.cam).toBe(CORNER_CAMERA);
      for (const [lx, ly] of [[0, 0], [FLOOR, 0], [0, FLOOR], [FLOOR, FLOOR]] as const) {
        const p = project(lx, ly, fit);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(w);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(h);
      }
      // …and the walls above the back corner too (the thing the whole-scene box exists for).
      expect(project(0, 0, fit).y - SCENE_RISE * fit.scale).toBeGreaterThanOrEqual(0);
    }
  });

  it('fitBox without a camera leaves cam unset so painted-path callers see the same object shape', () => {
    const fit = fitBox(1000, 800, ROOM_BOX);
    expect('cam' in fit).toBe(false);
    expect(fitFloor(1000, 800)).toEqual(fit);
    expect(fitFloor(1000, 800, CORNER_CAMERA).cam).toBe(CORNER_CAMERA);
  });
});
