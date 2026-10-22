import { describe, expect, it } from 'vitest';
import { appearanceOf, type Appearance } from '../appearance';
import { fitFloor } from '../iso';
import { recordingCtx } from '../recording-ctx';
import { drawFigureFrame, layersFor, type LayerId } from './figure';
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
  hat: 'none',
  cut: 'hoodie',
  accessory: 'glasses',
};

describe('layersFor (office realism Task 11)', () => {
  it('orders a femme member with a bun, glasses and a hoodie back to front, no visor', () => {
    expect(layersFor(femme, 'human', '#3366cc').map((l) => l.id)).toEqual([
      'skin',
      'hair/bun',
      'top/hoodie',
      'bottom',
      'shoes',
      'acc/glasses',
    ]);
    const top = layersFor(femme, 'human', '#3366cc').find((l) => l.id === 'top/hoodie');
    expect(top?.color).toBe('#3366cc');
  });

  it('an agent gets the visor last, and keeps its non-human skin tint', () => {
    const agent = appearanceOf({ name: 'cy', kind: 'agent' });
    const layers = layersFor(agent, 'agent');
    expect(layers[layers.length - 1]).toEqual({ id: 'visor', color: null });
    expect(layers[0]).toEqual({ id: 'skin', color: agent.skin });
  });

  it('what they carry draws after the clothes: a carrying walker gets its laptop layer, untinted', () => {
    const ids = layersFor(femme, 'human', null, { carry: 'laptop' }).map((l) => l.id);
    expect(ids).toEqual(['skin', 'hair/bun', 'top/hoodie', 'bottom', 'shoes', 'carry/laptop', 'acc/glasses']);
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
    const plain: Appearance = { ...femme, hair: 'bald', accessory: 'none' };
    expect(layersFor(plain, 'human').map((l) => l.id)).toEqual(['skin', 'top/hoodie', 'bottom', 'shoes']);
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
    const blits = ops.filter((o) => o.name === 'drawImage');
    expect(blits).toHaveLength(ids.length);
    // every layer is tinted, so each blit comes off the scratch's origin at the cell's size…
    expect(blits[0]!.args.slice(1, 5)).toEqual([0, 0, 64, 96]);
    // …and the scratch read frame 1 of the walk row for SE from the sheet: source x = 64, y = (8 + 1) * 96
    const reads = made.flatMap((m) => m.ops.filter((o) => o.name === 'drawImage' && o.args.length === 9));
    expect(reads[0]!.args.slice(1, 5)).toEqual([64, 9 * 96, 64, 96]);
    // every layer lands on the same destination rect
    const dests = new Set(blits.map((b) => JSON.stringify(b.args.slice(5))));
    expect(dests.size).toBe(1);
  });

  it('a missing sheet (a hair style with no render yet) is skipped, the rest still draw', () => {
    const { ctx, ops } = recordingCtx();
    const { create } = fakeCanvasFactory();
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
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(ids.length);
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
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(2);
    // read from the @arms cells (3×3), not the layer's own (10×10)
    const reads = made.flatMap((m) => m.ops.filter((o) => o.name === 'drawImage' && o.args.length === 9));
    expect(reads.every((r) => r.args[3] === 3 && r.args[4] === 3)).toBe(true);
  });

  it('the room tint multiplies every layer, and the untinted visor is tinted by it alone', () => {
    const { ctx, ops } = recordingCtx();
    const agent = appearanceOf({ name: 'cy', kind: 'agent' });
    const ids = layersFor(agent, 'agent').map((l) => l.id);
    const { create, made } = fakeCanvasFactory();
    drawFigureFrame({ ctx, fit, at: { lx: 0, ly: 0 }, sheets: allSheets(ids), spec, look: agent, kind: 'agent', anim: 'idle', dir: DIR8[0]!, t: 0, startT: 0, tint: '#b4bcd6', scratch: {}, create });
    const fills = made.flatMap((m) => m.ops.filter((o) => o.name === 'set:fillStyle').map((o) => o.args[0]));
    expect(fills).toContain('#b4bcd6'); // the visor, untinted by appearance, still takes the room's tint
    expect(fills).toContain(mulHex(agent.skin, '#b4bcd6'));
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(ids.length);
  });
});
