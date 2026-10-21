import { describe, expect, it } from 'vitest';
import { loadRenderedAssets, parseFigureSpec, renderedOfficeFromSearch } from './assets';
import { parseManifest } from './manifest';

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
