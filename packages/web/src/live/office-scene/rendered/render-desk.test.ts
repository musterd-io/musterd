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

/** Every static asset id the room's painters consult (plan Task 6), with how many times each is blitted. */
const STATIC_IDS: Record<string, number> = {
  'room/floor': 1,
  'room/wall-left': 1,
  'room/wall-right': 1,
  'rug/pod-0': 1,
  'rug/pod-1': 1,
  'rug/pod-2': 1,
  'rug/pod-3': 1,
  'rug/meeting': 1,
  'rug/reception': 1,
  'rug/nook': 1,
  'bench/base': 1,
  'plant/snake': 3,
  'plant/fiddle': 6, // five on the floor + reception's
  'shelf/0': 1,
  'shelf/1': 1,
  'shelf/2': 1,
  'shelf/3': 1,
  entrance: 1,
  'nook/fridge': 1,
  'nook/counter': 1,
  'nook/cooler': 1,
  'nook/couch': 1,
  'nook/table': 1,
  'reception/desk': 1,
  'reception/endtable': 1,
  'reception/armchair': 1,
  'meeting/table': 1,
  'meeting/chair-0': 1,
  'meeting/chair-1': 1,
  'meeting/chair-2': 1,
  'meeting/chair-3': 1,
  printer: 1,
};

describe('renderScene with the rendered room (plan Task 6)', () => {
  const fit = fitFloor(1200, 900);
  const empty = new Map();
  const run = (r?: RenderedAssets) => {
    const { ctx, ops } = recordingCtx();
    renderScene(ctx, fit, empty, new Map(), new Map(), 0, 'revive', undefined, null, undefined, null, undefined, undefined, r ? { rendered: r } : {});
    return ops;
  };
  const blits = (ops: ReturnType<typeof run>) => ops.filter((o) => o.name === 'drawImage' && o.args[0] === img).length;
  const total = Object.values(STATIC_IDS).reduce((a, b) => a + b, 0);

  it('blits every static item exactly once per placement, and nothing else from the manifest', () => {
    expect(blits(run(rendered(Object.keys(STATIC_IDS))))).toBe(total);
  });

  it('a missing asset falls back to its painter and only its own blits are gone', () => {
    for (const id of ['room/floor', 'plant/fiddle', 'nook/counter', 'rug/pod-1']) {
      const without = Object.keys(STATIC_IDS).filter((x) => x !== id);
      expect(blits(run(rendered(without)))).toBe(total - STATIC_IDS[id]!);
    }
  });

  it('with only one wall rendered the walls paint (the pair is one surface)', () => {
    const ids = Object.keys(STATIC_IDS).filter((x) => x !== 'room/wall-right');
    expect(blits(run(rendered(ids)))).toBe(total - 2);
  });

  it('the open fridge keeps its painter (a live state until Task 7)', () => {
    const { ctx, ops } = recordingCtx();
    renderScene(ctx, fit, empty, new Map(), new Map(), 0, 'revive', undefined, null, { fridgeOpen: true, bottleCarriers: new Set() }, null, undefined, undefined, {
      rendered: rendered(Object.keys(STATIC_IDS)),
    });
    expect(ops.filter((o) => o.name === 'drawImage' && o.args[0] === img).length).toBe(total - 1);
  });
});
