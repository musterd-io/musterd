import { describe, expect, it } from 'vitest';
import { loadFigureAssets, loadFigureLayers, loadRenderedAssets, parseFigureSpec, renderedOfficeFromSearch } from './assets';
import { parseManifest } from './manifest';
import { type LayerId, wornLayers } from './figure';
import { appearanceOf } from '../appearance';

const manifest = parseManifest({
  version: 1,
  camera: { kx: 0.70710678, ky: 0.35355339 },
  assets: [
    { id: 'desk/base', file: 'office-desk-base.png', w: 4, h: 4, anchor: { x: 2, y: 3 }, scale: 2 },
    { id: 'desk/lamp-on', file: 'office-desk-lamp.png', w: 4, h: 4, anchor: { x: 2, y: 3 }, scale: 2 },
  ],
});

describe('renderedOfficeFromSearch', () => {
  it('is on only for ?office=rendered', () => {
    expect(renderedOfficeFromSearch('?office=rendered')).toBe(true);
    expect(renderedOfficeFromSearch('?team=revive&office=rendered')).toBe(true);
    expect(renderedOfficeFromSearch('')).toBe(false);
    expect(renderedOfficeFromSearch('?office=painted')).toBe(false);
    expect(renderedOfficeFromSearch('?office')).toBe(false);
  });
});

describe('loadRenderedAssets', () => {
  it('resolves with the images that loaded and lists the ones that did not — never rejects', async () => {
    const fake = { fake: true } as unknown as CanvasImageSource;
    const urls: string[] = [];
    const r = await loadRenderedAssets(
      manifest,
      (file) => `/assets/${file}`,
      async (url) => {
        urls.push(url);
        if (url.endsWith('office-desk-lamp.png')) throw new Error('404');
        return fake;
      },
    );
    expect(urls).toEqual(['/assets/office-desk-base.png', '/assets/office-desk-lamp.png']);
    expect(r.images.get('desk/base')).toBe(fake);
    expect(r.images.has('desk/lamp-on')).toBe(false);
    expect(r.missing).toEqual(['office-desk-lamp.png']);
    expect(r.manifest).toBe(manifest);
  });
});

describe('parseFigureSpec (increment 3b)', () => {
  const base = {
    scale: 2,
    frame: { w: 112, h: 208 },
    anchor: { x: 56, y: 196 },
    layers: [{ id: 'skin', file: 'office-art-fig-skin.png' }],
    anims: Object.fromEntries(
      ['idle', 'walk', 'sit-type', 'sit-idle', 'speak', 'turn', 'sit-down', 'stand-up'].map((a, i) => [a, { row: i * 8, frames: 4, fps: 12, loop: true }]),
    ),
  };

  it('keeps the mirror map and a clip’s directions — dropping them drew every S/W figure as nothing', () => {
    const spec = parseFigureSpec({
      ...base,
      mirror: { S: 'E', W: 'N', SW: 'NE' },
      anims: { ...base.anims, 'g-sip': { row: 64, frames: 8, fps: 12, loop: false, dirs: ['E', 'S', 'W', 'N'] } },
    });
    expect(spec.mirror).toEqual({ S: 'E', W: 'N', SW: 'NE' });
    expect(spec.anims['g-sip']?.dirs).toEqual(['E', 'S', 'W', 'N']);
  });

  it('a sheet from before the gesture clips still parses', () => {
    expect(parseFigureSpec(base).anims['g-sip']).toBeUndefined();
  });
});

describe('only the sheets the team wears (lane 01M5GX1F3J)', () => {
  const ids: LayerId[] = ['skin', 'bottom', 'shoes', 'visor', 'hair/bob', 'hair/afro', 'top/tee', 'top/vest', 'acc/headphones', 'carry/laptop', 'lanyard'];
  const spec = parseFigureSpec({
    scale: 2,
    frame: { w: 144, h: 208 },
    anchor: { x: 72, y: 196 },
    anims: Object.fromEntries(
      ['idle', 'walk', 'sit-type', 'sit-idle', 'speak', 'turn', 'sit-down', 'stand-up'].map((a, i) => [a, { row: i * 8, frames: 1, fps: 12, loop: true }]),
    ),
    layers: ids.map((id) => ({ id, file: `office-art-fig-${id.replace('/', '-')}.png` })),
  });
  const fetched: string[] = [];
  const load = (url: string) => {
    fetched.push(url);
    return Promise.resolve({} as CanvasImageSource);
  };

  it('fetches only the wanted sheets, and a later call only what is still missing — never one sheet twice', async () => {
    fetched.length = 0;
    const fig = await loadFigureAssets(spec, (f) => f, load, new Set<LayerId>(['skin', 'hair/bob']));
    expect(fetched.sort()).toEqual(['office-art-fig-hair-bob.png', 'office-art-fig-skin.png']);
    const files = new Map(spec.layers.map((l) => [l.id, l.file] as const));
    const inFlight = new Set<LayerId>();
    await Promise.all([
      loadFigureLayers(fig.sheets, files, ['skin', 'top/vest'], (f) => f, load, inFlight),
      loadFigureLayers(fig.sheets, files, ['top/vest'], (f) => f, load, inFlight),
    ]);
    expect(fetched.filter((u) => u.includes('top-vest'))).toHaveLength(1);
    expect(fetched.filter((u) => u.includes('skin'))).toHaveLength(1);
    expect(fig.sheets.has('top/vest')).toBe(true);
  });

  it('a roster wears its own layers plus the props, and a dnd member adds the headphones', () => {
    const name = ['ada', 'bo', 'cy', 'dev', 'eli'].find((n) => appearanceOf({ name: n, kind: 'human' }).accessory !== 'headphones')!;
    const worn = wornLayers([{ name, kind: 'human', dnd: false }]);
    expect(worn.has('skin') && worn.has('carry/laptop') && worn.has('lanyard')).toBe(true);
    expect(worn.has('visor')).toBe(false); // no agent on this roster
    expect(worn.has('acc/headphones')).toBe(false);
    expect(wornLayers([{ name, kind: 'human', dnd: true }]).has('acc/headphones')).toBe(true);
    expect(wornLayers([{ name, kind: 'agent', dnd: false }]).has('visor')).toBe(true);
  });
});
