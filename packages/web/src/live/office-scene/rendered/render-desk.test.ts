import { describe, expect, it } from 'vitest';
import { fitFloor } from '../iso';
import { DESK_SLOTS } from '../layout';
import { recordingCtx } from '../recording-ctx';
import { renderScene } from '../render';
import type { RenderedAssets } from './assets';
import { parseManifest } from './manifest';

const img = { fake: true } as unknown as CanvasImageSource;
const asset = (id: string, file: string) => ({ id, file, w: 420, h: 300, anchor: { x: 210, y: 262 }, scale: 2.8284 });

function rendered(ids: string[]): RenderedAssets {
  const manifest = parseManifest({
    version: 1,
    camera: { kx: 0.70710678, ky: 0.35355339 },
    assets: ids.map((id) => asset(id, `office-${id.replace('/', '-')}.png`)),
  });
  return { manifest, images: new Map(ids.map((id) => [id, img])), missing: [] };
}

describe('renderScene with rendered desk bases (plan Task 3)', () => {
  const fit = fitFloor(1200, 900);
  const empty = new Map();
  const run = (r?: RenderedAssets) => {
    const { ctx, ops } = recordingCtx();
    renderScene(ctx, fit, empty, new Map(), new Map(), 0, 'revive', undefined, null, undefined, null, undefined, undefined, r ? { rendered: r } : {});
    return ops;
  };

  const blits = (ops: ReturnType<typeof run>) => ops.filter((o) => o.name === 'drawImage' && o.args[0] === img).length;

  it('blits the base once per desk, plus the clipped near half where that item exists', () => {
    const ops = run(rendered(['desk/base', 'desk/base-ew']));
    const n = blits(ops);
    expect(n).toBeGreaterThanOrEqual(DESK_SLOTS.length);
    // every near-half blit sits inside a clip
    expect(ops.filter((o) => o.name === 'clip').length).toBeGreaterThanOrEqual(n - DESK_SLOTS.length);
  });

  it('falls back to the painter for an orientation whose asset is missing', () => {
    const sn = DESK_SLOTS.filter((s) => s.dir === 'S' || s.dir === 'N').length;
    const both = blits(run(rendered(['desk/base', 'desk/base-ew'])));
    const onlySn = blits(run(rendered(['desk/base'])));
    const onlyEw = blits(run(rendered(['desk/base-ew'])));
    expect(onlySn).toBeGreaterThanOrEqual(sn);
    expect(onlyEw).toBeGreaterThanOrEqual(DESK_SLOTS.length - sn);
    expect(onlySn + onlyEw).toBe(both);
  });

  it('is byte-identical to the painted office without a manifest', () => {
    const a = run();
    const b = run({ manifest: parseManifest({ version: 1, camera: { kx: 1, ky: 1 }, assets: [] }), images: new Map(), missing: [] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(blits(a)).toBe(0);
  });
});
