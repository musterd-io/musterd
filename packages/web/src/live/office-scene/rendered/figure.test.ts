import { describe, expect, it } from 'vitest';
import { appearanceOf, type Appearance } from '../appearance';
import { fitFloor } from '../iso';
import { recordingCtx } from '../recording-ctx';
import { COMPOSITE_CAP, compositeCapFor, drawFigureFrame, layersFor, type LayerId } from './figure';
import { DIR8, type SheetSpec } from './figureSheet';
import { mulHex, tintFrame } from './tint';

const spec: SheetSpec = {
  scale: 3,
  frame: { w: 64, h: 96 },
  anchor: { x: 32, y: 88 },
  anims: {
    idle: { row: 0, frames: 8, fps: 12, loop: true },
    walk: { row: 8, frames: 6, fps: 12, loop: true },
    'sit-type': { row: 16, frames: 6, fps: 12, loop: true },
    'sit-idle': { row: 24, frames: 8, fps: 12, loop: true },
    speak: { row: 32, frames: 8, fps: 12, loop: true },
    turn: { row: 40, frames: 4, fps: 12, loop: false },
    'sit-down': { row: 48, frames: 6, fps: 12, loop: false },
    'stand-up': { row: 56, frames: 6, fps: 12, loop: false },
  },
};

const femme: Appearance = {
  ...appearanceOf({ name: 'ada', kind: 'human' }),
  hair: 'bun',
  facialHair: 'none',
  outer: 'none', // pinned: the outer pools grow (v2-5b), and ada's draw must not change this test's subject
  hat: 'none',
  cut: 'hoodie',
  eyes: 'glasses',
  ears: 'none',
  neck: 'none',
  accessory: 'glasses',
};

describe('layersFor (office realism Task 11)', () => {
  it('draws the eyes over the skin, shoes and trousers under the top, and hair over it (figure v2)', () => {
    expect(layersFor(femme, 'human', '#3366cc').map((l) => l.id)).toEqual([
      'skin',
      'eyes',
      'mouth/soft',
      'shoes',
      'bottom',
      'top/hoodie',
      'hair/bun',
      'acc/glasses',
    ]);
    const top = layersFor(femme, 'human', '#3366cc').find((l) => l.id === 'top/hoodie');
    expect(top?.color).toBe('#3366cc');
  });

  it('the outermost top carries the hue: under a cardigan the shirt takes its own plain colour (v2-5b)', () => {
    const look: Appearance = { ...femme, cut: 'long', outer: 'cardigan', underColor: '#f2eee6' };
    const layers = layersFor(look, 'human', '#3366cc');
    expect(layers.find((l) => l.id === 'top/long')?.color).toBe('#f2eee6');
    expect(layers.find((l) => l.id === 'outer/cardigan')?.color).toBe('#3366cc');
    expect(layers.findIndex((l) => l.id === 'outer/cardigan')).toBe(layers.findIndex((l) => l.id === 'top/long') + 1);
  });

  it('an agent wears no visor: its eyes and a collar light glow in its identity colour (figure v2)', () => {
    const agent: Appearance = { ...appearanceOf({ name: 'cy', kind: 'agent' }), hair: 'short', facialHair: 'none', hat: 'none', eyes: 'none', ears: 'none', neck: 'none', wrist: 'none', outer: 'none', accessory: 'none', cut: 'tee' };
    const layers = layersFor(agent, 'agent', '#5b8def');
    expect(layers.map((l) => l.id)).toEqual(['skin', 'eyes', 'tell/eyes', `mouth/${agent.smile}`, 'shoes', 'bottom', 'top/tee', 'tell/collar', 'hair/short']);
    expect(layers.find((l) => l.id === 'tell/eyes')?.color).toBe('#5b8def');
    expect(layers.find((l) => l.id === 'tell/collar')?.color).toBe('#5b8def');
    expect(layers[0]).toEqual({ id: 'skin', color: agent.skin });
  });

  it("a member's mouth is their own smile, in a darker shade of their skin", () => {
    const wide: Appearance = { ...femme, smile: 'wide' };
    const mouth = layersFor(wide, 'human').find((l) => l.id.startsWith('mouth/'));
    expect(mouth).toEqual({ id: 'mouth/wide', color: wide.skin });
  });

  it('a human has neither tell', () => {
    expect(layersFor(femme, 'human', '#3366cc').some((l) => l.id.startsWith('tell/'))).toBe(false);
  });

  it('what they carry draws after the clothes: a carrying walker gets its laptop layer, untinted', () => {
    const ids = layersFor(femme, 'human', null, { carry: 'laptop' }).map((l) => l.id);
    expect(ids).toEqual(['skin', 'eyes', 'mouth/soft', 'shoes', 'bottom', 'top/hoodie', 'carry/laptop', 'hair/bun', 'acc/glasses']);
    expect(layersFor(femme, 'human', null, { carry: 'laptop' }).find((l) => l.id === 'carry/laptop')?.color).toBeNull();
  });

  it('the moving box is the box in kraft with the plant; a mug takes the desk mug colour; a lanyard its own', () => {
    const moving = layersFor(femme, 'human', null, { carry: 'movingBox' });
    expect(moving.filter((l) => l.id.startsWith('carry/'))).toEqual([
      { id: 'carry/box', color: '#c9a26b' },
      { id: 'carry/plant', color: null },
    ]);
    expect(layersFor(femme, 'human', null, { mug: '#aa3344' }).find((l) => l.id === 'carry/mug')?.color).toBe('#aa3344');
    expect(layersFor(femme, 'human', null, { carry: 'mug' }).find((l) => l.id === 'carry/mug')?.color).toBe('#d6d0c6');
    const badge = layersFor(femme, 'human', null, { lanyard: '#22aa66' });
    expect(badge.filter((l) => l.id.startsWith('lanyard'))).toEqual([
      { id: 'lanyard', color: '#22aa66' },
      { id: 'lanyard-card', color: null },
    ]);
  });

  it('bald, clean-shaven, hatless, no accessory: only the base layers', () => {
    const plain: Appearance = { ...femme, hair: 'bald', eyes: 'none', ears: 'none', neck: 'none', accessory: 'none' };
    expect(layersFor(plain, 'human').map((l) => l.id)).toEqual(['skin', 'eyes', 'mouth/soft', 'shoes', 'bottom', 'top/hoodie']);
  });
});

/** A fake canvas whose context records, so the tint pass is observable under node. */
function fakeCanvasFactory() {
  const made: Array<{ ops: ReturnType<typeof recordingCtx>['ops'] }> = [];
  const create = (w: number, h: number) => {
    const rec = recordingCtx();
    made.push({ ops: rec.ops });
    return { width: w, height: h, getContext: () => rec.ctx } as unknown as HTMLCanvasElement;
  };
  return { create, made };
}

describe('tintFrame', () => {
  const src = { width: 1024, height: 4096 } as unknown as CanvasImageSource;

  it('draws the cell once, multiplies the colour over it, and cuts back to its alpha — on the scratch', () => {
    const { create, made } = fakeCanvasFactory();
    const scratch = create(10, 10);
    const out = tintFrame(scratch, src, 100, 200, 40, 70, '#aabbcc');
    expect(out).toBe(scratch);
    expect(made).toHaveLength(1);
    const ops = made[0]!.ops;
    const draws = ops.filter((o) => o.name === 'drawImage');
    expect(draws).toHaveLength(2);
    expect(draws[0]!.args.slice(1, 5)).toEqual([100, 200, 40, 70]);
    expect(ops.some((o) => o.name === 'set:globalCompositeOperation' && o.args[0] === 'multiply')).toBe(true);
    expect(ops.some((o) => o.name === 'set:fillStyle' && o.args[0] === '#aabbcc')).toBe(true);
    expect(ops.filter((o) => o.name === 'fillRect')).toHaveLength(1);
    expect(ops.some((o) => o.name === 'set:globalCompositeOperation' && o.args[0] === 'destination-in')).toBe(true);
    // the scratch grew to the cell, never to the sheet
    expect([scratch.width, scratch.height]).toEqual([40, 70]);
  });

  it('mulHex multiplies channels and is the identity under white', () => {
    expect(mulHex('#ff8000', '#ffffff')).toBe('#ff8000');
    expect(mulHex('#ff8000', '#808080')).toBe('#804000');
  });
});

describe('drawFigureFrame', () => {
  const fit = fitFloor(1200, 900);
  const sheet = (id: string) => ({ width: 512, height: 6144, id }) as unknown as CanvasImageSource;
  const allSheets = (ids: LayerId[]) => new Map<LayerId, CanvasImageSource>(ids.map((id) => [id, sheet(id)]));

  it('blits one frame per layer that has a sheet, in layer order, at the frame rect', () => {
    const { ctx, ops } = recordingCtx();
    const { create, made } = fakeCanvasFactory();
    const ids = layersFor(femme, 'human').map((l) => l.id);
    drawFigureFrame({
      ctx,
      fit,
      at: { lx: 450, ly: 450 },
      sheets: allSheets(ids),
      spec,
      look: femme,
      kind: 'human',
      topColor: '#3366cc',
      anim: 'walk',
      dir: 'SE',
      t: 1 / 12,
      startT: 0,
      scratch: {},
      create,
    });
    // the room gets ONE blit: the member's composed frame, its anchor on the floor point
    const blits = ops.filter((o) => o.name === 'drawImage');
    expect(blits).toHaveLength(1);
    const k = fit.scale / spec.scale;
    expect(blits[0]!.args.slice(1, 5)).toEqual([0, 0, 64, 96]);
    expect(blits[0]!.args[7]).toBeCloseTo(64 * k);
    expect(blits[0]!.args[8]).toBeCloseTo(96 * k);
    // the composite (the first canvas made) holds one layer per sheet, each off the scratch's origin…
    const layers = made[0]!.ops.filter((o) => o.name === 'drawImage');
    expect(layers).toHaveLength(ids.length);
    expect(layers[0]!.args.slice(1, 9)).toEqual([0, 0, 64, 96, 0, 0, 64, 96]);
    // …and the scratch read frame 1 of the walk row for SE from the sheet: source x = 64, y = (8 + 1) * 96
    const reads = made[1]!.ops.filter((o) => o.name === 'drawImage');
    expect(reads[0]!.args.slice(1, 5)).toEqual([64, 9 * 96, 64, 96]);
  });

  it('a missing sheet (a hair style with no render yet) is skipped, the rest still draw', () => {
    const { ctx, ops } = recordingCtx();
    const { create, made } = fakeCanvasFactory();
    const ids = layersFor(femme, 'human').map((l) => l.id).filter((id) => id !== 'hair/bun');
    drawFigureFrame({
      ctx,
      fit,
      at: { lx: 100, ly: 100 },
      sheets: allSheets(ids),
      spec,
      look: femme,
      kind: 'human',
      anim: 'idle',
      dir: 'N',
      t: 0,
      startT: 0,
      scratch: {},
      create,
    });
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(1);
    expect(made[0]!.ops.filter((o) => o.name === 'drawImage')).toHaveLength(ids.length);
  });

  it('the seated overlay (part arms) draws only the layers that stored arm cells, from those cells', () => {
    const { ctx, ops } = recordingCtx();
    const { create, made } = fakeCanvasFactory();
    const ids = layersFor(femme, 'human').map((l) => l.id);
    const cellsOf = (n: number) => Array.from({ length: 64 * 8 * 8 }, (_, i) => (i % 6 < 4 ? n : 0));
    const packed: SheetSpec = {
      ...spec,
      cells: {
        ...Object.fromEntries(ids.map((id) => [id, cellsOf(10)])),
        'skin@arms': cellsOf(3),
        'top/hoodie@arms': cellsOf(3),
      },
    };
    drawFigureFrame({
      ctx,
      fit,
      at: { lx: 300, ly: 300 },
      sheets: allSheets(ids),
      spec: packed,
      look: femme,
      kind: 'human',
      anim: 'sit-type',
      dir: 'E',
      t: 0,
      startT: 0,
      part: 'arms',
      scratch: {},
      create,
    });
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(1);
    expect(made[0]!.ops.filter((o) => o.name === 'drawImage')).toHaveLength(2);
    // read from the @arms cells (3×3), not the layer's own (10×10)
    const reads = made[1]!.ops.filter((o) => o.name === 'drawImage');
    expect(reads.every((r) => r.args[3] === 3 && r.args[4] === 3)).toBe(true);
  });

  it('a stretched build draws each layer wider about the floor point, mirrored or not', () => {
    const draw = (build: number, dir: 'SE' | 'S') => {
      const { ctx, ops } = recordingCtx();
      const { create, made } = fakeCanvasFactory();
      const look: Appearance = { ...femme, hair: 'bald', eyes: 'none', ears: 'none', neck: 'none', accessory: 'none', build };
      const ids = layersFor(look, 'human').map((l) => l.id);
      // packed 64×64 cells at offset 0 (mirroring applies to packed cells only)
      const cells = Array.from({ length: 64 * 8 * 8 * 6 }, (_, i) => (i % 6 < 4 ? 64 : 0));
      const mirrored: SheetSpec = { ...spec, mirror: { S: 'E' }, cells: Object.fromEntries(ids.map((id) => [id, cells])) };
      drawFigureFrame({ ctx, fit, at: { lx: 450, ly: 450 }, sheets: allSheets(ids), spec: mirrored, look, kind: 'human', anim: 'idle', dir, t: 0, startT: 0, scratch: {}, create });
      return { ops, composite: made[0]!.ops };
    };
    const k = fit.scale / spec.scale;
    const flat = draw(1, 'SE').ops.find((o) => o.name === 'drawImage')!.args as number[];
    const wide = draw(1.04, 'SE').ops.find((o) => o.name === 'drawImage')!.args as number[];
    // the floor point (anchor.x = 32 into a 64-wide frame) stays put; the width grows 4%
    expect(wide[7]).toBeCloseTo(64 * k * 1.04);
    expect(wide[5]).toBeCloseTo(flat[5]! + 32 * k - 32 * k * 1.04);
    expect(wide[8]).toBeCloseTo(flat[8]!);
    // a mirrored direction lands on the same stretched rect; the flip is inside the composite, about the cell's right edge
    const s = draw(1.04, 'S');
    expect(s.ops.find((o) => o.name === 'drawImage')!.args.slice(5)).toEqual(wide.slice(5));
    expect(s.composite.find((o) => o.name === 'translate')!.args).toEqual([64, 0]);
    expect(s.composite.find((o) => o.name === 'scale')!.args).toEqual([-1, 1]);
  });

  it('the room tint multiplies every layer, and the untinted eyes are tinted by it alone', () => {
    const { ctx, ops } = recordingCtx();
    const agent = appearanceOf({ name: 'cy', kind: 'agent' });
    const ids = layersFor(agent, 'agent').map((l) => l.id);
    const { create, made } = fakeCanvasFactory();
    drawFigureFrame({ ctx, fit, at: { lx: 0, ly: 0 }, sheets: allSheets(ids), spec, look: agent, kind: 'agent', anim: 'idle', dir: DIR8[0]!, t: 0, startT: 0, tint: '#b4bcd6', scratch: {}, create });
    const fills = made.flatMap((m) => m.ops.filter((o) => o.name === 'set:fillStyle').map((o) => o.args[0]));
    expect(fills).toContain('#b4bcd6'); // the eyes, untinted by appearance, still take the room's tint
    expect(fills).toContain(mulHex(agent.skin, '#b4bcd6'));
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(1);
    expect(made[0]!.ops.filter((o) => o.name === 'drawImage')).toHaveLength(ids.length);
  });

  it('composes a frame once: the same pixels again are one blit and no tinting; a new frame composes anew', () => {
    const { create, made } = fakeCanvasFactory();
    const ids = layersFor(femme, 'human').map((l) => l.id);
    const scratch = {};
    const draw = (t: number, tint?: string) => {
      const { ctx, ops } = recordingCtx();
      drawFigureFrame({ ctx, fit, at: { lx: 450, ly: 450 }, sheets: allSheets(ids), spec, look: femme, kind: 'human', anim: 'walk', dir: 'SE', t, startT: 0, scratch, create, ...(tint ? { tint } : {}) });
      return ops.filter((o) => o.name === 'drawImage').length;
    };
    const tinted = () => made.reduce((n, m) => n + m.ops.filter((o) => o.name === 'fillRect').length, 0);
    expect(draw(1 / 12)).toBe(1);
    const once = tinted();
    expect(draw(1 / 12)).toBe(1);
    expect(tinted()).toBe(once); // a hit: nothing re-tinted
    expect(made).toHaveLength(2); // one composite + the scratch
    draw(2 / 12); // the next walk frame
    expect(made).toHaveLength(3);
    draw(1 / 12, '#b4bcd6'); // the evening tint is different pixels
    expect(made).toHaveLength(4);
  });

  it(`keeps at most ${COMPOSITE_CAP} composed frames, reusing the stalest canvas`, () => {
    const { create, made } = fakeCanvasFactory();
    const ids = layersFor(femme, 'human').map((l) => l.id);
    const scratch: { composites?: Map<string, HTMLCanvasElement> } = {};
    const { ctx } = recordingCtx();
    for (let i = 0; i <= COMPOSITE_CAP; i++) {
      const tint = `#${(0x100000 + i).toString(16)}`;
      drawFigureFrame({ ctx, fit, at: { lx: 0, ly: 0 }, sheets: allSheets(ids), spec, look: femme, kind: 'human', anim: 'idle', dir: 'S', t: 0, startT: 0, tint, scratch, create });
    }
    expect(scratch.composites!.size).toBe(COMPOSITE_CAP);
    expect(made).toHaveLength(COMPOSITE_CAP + 1); // the cap's canvases + the scratch; the last one reused the stalest
  });

  it('the cap grows with the floor: ~48 frames a figure, never under the floor minimum', () => {
    expect(compositeCapFor(0)).toBe(COMPOSITE_CAP);
    expect(compositeCapFor(14)).toBe(16 * 48);
    const scratch: { composites?: Map<string, HTMLCanvasElement>; cap?: number } = { cap: 4 };
    const { create } = fakeCanvasFactory();
    const ids = layersFor(femme, 'human').map((l) => l.id);
    const { ctx } = recordingCtx();
    for (let i = 0; i < 10; i++) {
      drawFigureFrame({ ctx, fit, at: { lx: 0, ly: 0 }, sheets: allSheets(ids), spec, look: femme, kind: 'human', anim: 'idle', dir: 'S', t: 0, startT: 0, tint: `#${(0x100000 + i).toString(16)}`, scratch, create });
    }
    expect(scratch.composites!.size).toBe(4);
  });
});
