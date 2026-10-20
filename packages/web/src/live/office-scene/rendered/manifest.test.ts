import { describe, expect, it } from 'vitest';
import { assetById, parseManifest } from './manifest';

const desk = {
  id: 'desk/base',
  file: 'office-desk-base.png',
  w: 420,
  h: 300,
  anchor: { x: 210, y: 262 },
  scale: 2.8284,
};
const good = { version: 1, camera: { kx: 0.70710678, ky: 0.35355339 }, assets: [desk] };

describe('parseManifest', () => {
  it('returns a one-asset manifest typed, untouched', () => {
    const m = parseManifest(JSON.parse(JSON.stringify(good)));
    expect(m.version).toBe(1);
    expect(m.camera).toEqual(good.camera);
    expect(m.assets).toEqual([desk]);
  });

  it('refuses a version it does not know', () => {
    expect(() => parseManifest({ ...good, version: 2 })).toThrow(/version/);
  });

  it('refuses an asset without an anchor', () => {
    const noAnchor: Record<string, unknown> = { ...desk };
    delete noAnchor['anchor'];
    expect(() => parseManifest({ ...good, assets: [noAnchor] })).toThrow(/anchor/);
  });

  it('refuses something that is not an object at all', () => {
    expect(() => parseManifest(null)).toThrow(/manifest/);
    expect(() => parseManifest('nope')).toThrow(/manifest/);
  });
});

describe('assetById', () => {
  it('finds an asset by id and answers undefined for an unknown one', () => {
    const m = parseManifest(good);
    expect(assetById(m, 'desk/base')).toEqual(desk);
    expect(assetById(m, 'desk/lamp-on')).toBeUndefined();
  });
});
