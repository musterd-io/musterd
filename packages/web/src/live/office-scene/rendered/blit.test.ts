import { describe, expect, it } from 'vitest';
import { fitFloor, project } from '../iso';
import { recordingCtx } from '../recording-ctx';
import { blitAsset } from './blit';
import type { RenderedAsset } from './manifest';

const desk: RenderedAsset = {
  id: 'desk/base',
  file: 'office-desk-base.png',
  w: 420,
  h: 300,
  anchor: { x: 210, y: 262 },
  scale: 2.8284,
};
const img = { fake: true } as unknown as CanvasImageSource;

describe('blitAsset', () => {
  const fit = fitFloor(1200, 900);

  it('draws the image once so that its anchor lands on the projected floor point', () => {
    const { ctx, ops } = recordingCtx();
    blitAsset(ctx, fit, desk, img, 215, 290);
    const draws = ops.filter((o) => o.name === 'drawImage');
    expect(draws).toHaveLength(1);
    const k = fit.scale / desk.scale;
    const at = project(215, 290, fit);
    const [src, dx, dy, dw, dh] = draws[0]!.args as [unknown, number, number, number, number];
    expect(src).toBe(img);
    expect(dx).toBeCloseTo(at.x - desk.anchor.x * k, 6);
    expect(dy).toBeCloseTo(at.y - desk.anchor.y * k, 6);
    expect(dw).toBeCloseTo(desk.w * k, 6);
    expect(dh).toBeCloseTo(desk.h * k, 6);
  });

  it('leaves globalAlpha alone at alpha 1 and sets then restores it otherwise', () => {
    const plain = recordingCtx();
    blitAsset(plain.ctx, fit, desk, img, 0, 0);
    expect(plain.ops.some((o) => o.name === 'set:globalAlpha')).toBe(false);

    const faded = recordingCtx();
    blitAsset(faded.ctx, fit, desk, img, 0, 0, 0.4);
    const names = faded.ops.map((o) => o.name);
    expect(names).toEqual(['save', 'set:globalAlpha', 'drawImage', 'restore']);
    expect(faded.ops[1]!.args).toEqual([0.4]);
  });
});
