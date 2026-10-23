import { describe, expect, it } from 'vitest';
import { fitFloor } from '../iso';
import { memberColor } from '../../format';
import { computeLightEnv } from '../lighting';
import type { OfficeNode } from '../types';

function officeNode(name: string): OfficeNode {
  return {
    name,
    kind: 'human',
    service: false,
    woken: false,
    presence: 'online',
    activity: 'working',
    posture: 'working',
    state: null,
    color: memberColor(name, 'human'),
    role: '',
    surface: null,
    model: null,
    workTitle: null,
    workSource: null,
    laneState: null,
    moreLanes: 0,
    dnd: false,
    offline_reason: null,
    last_seen_at: null,
    created_at: null,
    sponsored_by: null,
  };
}
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
  'room/light-day': 1,
  'room/ceiling-on': 1, // DAY_ENV: noon, occupied → day-on
  'room/light-evening': 0,
  'room/light-night': 0,
  'room/ceiling-spill': 0,
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
    for (const id of ['room/ceiling-on', 'plant/fiddle', 'nook/counter', 'rug/pod-1']) {
      const without = Object.keys(STATIC_IDS).filter((x) => x !== id);
      expect(blits(run(rendered(without)))).toBe(total - STATIC_IDS[id]!);
    }
  });

  it('mid-fade the shell draws both day states, the second at the mix (plan Task 8)', () => {
    const { ctx, ops } = recordingCtx();
    const env = computeLightEnv(16 + 52.5 / 60, true); // day → evening, mix 0.5
    renderScene(ctx, fit, empty, new Map(), new Map(), 0, 'revive', env, null, undefined, null, undefined, undefined, {
      rendered: rendered(Object.keys(STATIC_IDS)),
    });
    expect(ops.filter((o) => o.name === 'drawImage' && o.args[0] === img).length).toBe(total + 1); // the `to` layer over the `from`
    const alphas = ops.filter((o) => o.name === 'set:globalAlpha').map((o) => o.args[0] as number);
    expect(alphas.some((a) => Math.abs(a - 0.5) < 1e-6)).toBe(true);
    // the ceiling overlay is added, not painted over
    expect(ops.some((o) => o.name === 'set:globalCompositeOperation' && o.args[0] === 'lighter')).toBe(true);
  });

  it('an empty office at night draws the night shell and no ceiling overlay', () => {
    const { ctx, ops } = recordingCtx();
    renderScene(ctx, fit, empty, new Map(), new Map(), 0, 'revive', computeLightEnv(23, false), null, undefined, null, undefined, undefined, {
      rendered: rendered(Object.keys(STATIC_IDS)),
    });
    expect(ops.filter((o) => o.name === 'drawImage' && o.args[0] === img).length).toBe(total - 1); // no ceiling-on
  });

  it('the open fridge keeps its painter (a live state until Task 7)', () => {
    const { ctx, ops } = recordingCtx();
    renderScene(ctx, fit, empty, new Map(), new Map(), 0, 'revive', undefined, null, { fridgeOpen: true, bottleCarriers: new Set() }, null, undefined, undefined, {
      rendered: rendered(Object.keys(STATIC_IDS)),
    });
    expect(ops.filter((o) => o.name === 'drawImage' && o.args[0] === img).length).toBe(total - 1);
  });
});

describe('rendered per-desk overlays (plan Task 7)', () => {
  const fit = fitFloor(1200, 900);
  const ids = ['desk/lamp-off', 'desk/lamp-on', 'desk/fan-0', 'desk/fan-1', 'desk/fan-2', 'desk/fan-3'];
  const seat = (name: string, slot: number) => {
    const placements = new Map([[name, { kind: 'desk' as const, slot, owned: false }]]);
    const byName = new Map([[name, officeNode(name)]]);
    return { placements, byName };
  };
  const blitsOf = (ops: ReturnType<typeof recordingCtx>['ops'], id: string) =>
    ops.filter((o) => o.name === 'drawImage' && o.args[0] === img && (o as unknown as { id?: string }).id === id).length;
  const run = (hours: number, occupied: boolean, t = 0) => {
    const { ctx, ops } = recordingCtx();
    const r = rendered(ids);
    // tag each image so a blit can be told apart by asset: the loader gives one image per id
    for (const id of ids) r.images.set(id, { fake: true, id } as unknown as CanvasImageSource);
    const { placements, byName } = occupied ? seat('ada', 0) : { placements: new Map(), byName: new Map() };
    renderScene(ctx, fit, placements, byName, new Map(), t, 'revive', computeLightEnv(hours, occupied), null, undefined, null, undefined, undefined, {
      rendered: r,
    });
    const by = (id: string) => ops.filter((o) => o.name === 'drawImage' && (o.args[0] as { id?: string }).id === id).length;
    return { by, ops };
  };
  void blitsOf;

  // Slot 0 faces S, so its lamp (along +8) stands on the near half and is blitted twice: once with
  // the desk, once more over the near half's repaint (`nearHalfProps`).
  it('an occupied desk at night blits the lit lamp; by day the unlit one; an empty desk none', () => {
    expect(run(22, true).by('desk/lamp-on')).toBe(2);
    expect(run(22, true).by('desk/lamp-off')).toBe(0);
    expect(run(12, true).by('desk/lamp-off')).toBe(2);
    expect(run(12, true).by('desk/lamp-on')).toBe(0);
    const empty = run(22, false);
    expect(empty.by('desk/lamp-on') + empty.by('desk/lamp-off')).toBe(0);
  });

  it('a prop on the near half is painted again after the near half repaints the worktop', () => {
    // The near half re-blits the desk base at the front edge's depth; a prop standing on that half
    // used to lose its foot to it — a fan sunk into the slab (nick, 2026-10-21).
    const { ctx, ops } = recordingCtx();
    const r = rendered([...ids, 'desk/base']);
    for (const id of [...ids, 'desk/base']) r.images.set(id, { fake: true, id } as unknown as CanvasImageSource);
    const placements = new Map([['ada', { kind: 'desk' as const, slot: 0 }]]);
    const byName = new Map([['ada', officeNode('ada')]]);
    renderScene(ctx, fit, placements, byName, new Map(), 0, 'revive', computeLightEnv(12, true), null, undefined, null, undefined, undefined, {
      rendered: r,
    });
    const idOf = (o: (typeof ops)[number]) => (o.name === 'drawImage' ? (o.args[0] as { id?: string }).id : undefined);
    const bases = ops.flatMap((o, i) => (idOf(o) === 'desk/base' ? [i] : []));
    const lamps = ops.flatMap((o, i) => (idOf(o) === 'desk/lamp-off' ? [i] : []));
    expect(lamps.length).toBe(2);
    // the second lamp lands after the near half's base, which comes after the first lamp
    const nearBase = bases.find((i) => i > lamps[0]!);
    expect(nearBase).toBeDefined();
    expect(lamps[1]!).toBeGreaterThan(nearBase!);
  });

  it('the fan frame advances with t only while someone is at the desk', () => {
    // find a desk that has a fan at all, by looking for any fan blit over the first few slots
    const framesAt = (t: number, occupied: boolean) => {
      const r = run(12, occupied, t);
      return [0, 1, 2, 3].map((f) => r.by(`desk/fan-${f}`));
    };
    const idle = framesAt(0.9, false);
    expect(idle.slice(1).reduce((a, b) => a + b, 0)).toBe(0); // nobody there: every fan is on frame 0
    expect(idle[0]).toBeGreaterThan(0);
    // ada sits at slot 0; whether slot 0 has a fan is a hash, so compare the totals across t instead
    const a = framesAt(0, true);
    const b = framesAt(0.9, true); // floor(0.9*8) % 4 = 3
    expect(a.reduce((x, y) => x + y, 0)).toBe(b.reduce((x, y) => x + y, 0));
  });
});

describe('the rendered figure (plan Task 13)', () => {
  const fit = fitFloor(1200, 900);
  const ids = ['desk/base', 'desk/base-ew'];
  const spec = {
    scale: 2,
    frame: { w: 128, h: 232 },
    anchor: { x: 64, y: 220 },
    anims: {
      idle: { row: 0, frames: 6, fps: 12, loop: true },
      walk: { row: 8, frames: 6, fps: 12, loop: true },
      'sit-type': { row: 16, frames: 4, fps: 12, loop: true },
      'sit-idle': { row: 24, frames: 6, fps: 12, loop: true },
      speak: { row: 32, frames: 6, fps: 12, loop: true },
      turn: { row: 40, frames: 3, fps: 12, loop: false },
      'sit-down': { row: 48, frames: 4, fps: 12, loop: false },
      'stand-up': { row: 56, frames: 4, fps: 12, loop: false },
    },
  } as const;
  const sheetImg = (id: string) => ({ width: 1024, height: 14848, id }) as unknown as CanvasImageSource;
  const withFigure = (): RenderedAssets => {
    const r = rendered(ids);
    const layers = ['skin', 'hair/short', 'top/tee', 'bottom', 'shoes', 'tell/eyes'] as const;
    r.figure = {
      spec: { ...spec, anims: { ...spec.anims } },
      sheets: new Map(layers.map((l) => [l, sheetImg(l)])),
      scratch: {},
    };
    return r;
  };
  const standing = (name: string) => {
    const poses = new Map([[name, { lx: 300, ly: 400, dir: 'S', small: false, carry: null, bubble: null, alpha: 1, moving: true, run: false, gesture: 0, gestureT: 0, sit: 0, heading: Math.PI / 4 } as never]]);
    const byName = new Map([[name, officeNode(name)]]);
    return { poses, byName };
  };

  it('a walking member is sprite layers (one blit per loaded layer) at the SE row, not a skeleton', () => {
    const { ctx, ops } = recordingCtx();
    const { poses, byName } = standing('ada');
    const r = withFigure();
    // the tint pass needs a canvas; under node, give it a recording one
    const origCreate = globalThis.document;
    const scratch = recordingCtx(); // the one scratch canvas the tint pass draws every frame through
    (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => scratch.ctx }) };
    try {
      renderScene(ctx, fit, new Map(), byName, poses, 3, 'revive', undefined, null, undefined, null, undefined, undefined, { rendered: r });
    } finally {
      (globalThis as { document?: unknown }).document = origCreate;
    }
    const sheetBlits = ops.filter((o) => o.name === 'drawImage' && o.args.length === 9);
    // five layers for ada (no agent tell) plus the receptionist's, each tinted on the scratch and blitted from it
    expect(sheetBlits.length).toBeGreaterThanOrEqual(5);
    // …and the scratch read ada's five from the walk row for SE (row 8 + 1) of their sheets; the
    // receptionist (seated, facing S) reads from a sit row
    const reads = scratch.ops.filter((o) => o.name === 'drawImage' && o.args.length === 9 && (o.args[0] as { id?: string }).id !== undefined);
    expect(reads.filter((b) => b.args[2] === 9 * 232).length).toBe(10); // two reads per tint pass (draw, then destination-in)
    expect(reads.filter((b) => b.args[2] === (24 + 2) * 232).length).toBeGreaterThanOrEqual(6); // sit-idle row for S
    // and no skeleton painting beside them: the painted character is dozens of fills more
    const painted = recordingCtx();
    renderScene(painted.ctx, fit, new Map(), byName, poses, 3, 'revive', undefined, null, undefined, null, undefined, undefined, { rendered: rendered(ids) });
    expect(ops.length).toBeLessThan(painted.ops.length - 40);
  });

  it('without figure sheets the member paints exactly as before', () => {
    const { poses, byName } = standing('ada');
    const a = recordingCtx();
    renderScene(a.ctx, fit, new Map(), byName, poses, 3, 'revive', undefined, null, undefined, null, undefined, undefined, {});
    const b = recordingCtx();
    renderScene(b.ctx, fit, new Map(), byName, poses, 3, 'revive', undefined, null, undefined, null, undefined, undefined, { rendered: rendered([]) });
    expect(JSON.stringify(b.ops)).toBe(JSON.stringify(a.ops));
    expect(a.ops.filter((o) => o.name === 'drawImage' && o.args.length === 9)).toHaveLength(0);
  });
});
