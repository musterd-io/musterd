import { describe, expect, it } from 'vitest';
import { assetById, cameraMatches, parseManifest } from './manifest';

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

describe('cameraMatches', () => {
  it('accepts the camera it was rendered at, within rounding', () => {
    const m = parseManifest(good);
    expect(cameraMatches(m, { kx: 0.70710678, ky: 0.35355339 })).toBe(true);
    expect(cameraMatches(m, { kx: 0.7071, ky: 0.35355 })).toBe(true);
  });

  it('refuses a different elevation — the corner camera over an isometric render', () => {
    const m = parseManifest(good);
    expect(cameraMatches(m, { kx: 0.70710678, ky: 0.31 })).toBe(false);
  });
});

describe('view plates (window views, lane 01M6ENGW2H)', () => {
  const span = { which: 0, t0: 0.28, t1: 0.46, u0: 0.34, u1: 0.82 };
  const plate = (state: string, over: Record<string, unknown> = {}) => ({
    id: `view/city/0-0-${state}`,
    file: `office-art-view-city-0-0-${state}.webp`,
    w: 300,
    h: 420,
    anchor: { x: 0, y: 0 },
    scale: 3,
    view: { ...span, ...over },
  });

  it('parseManifest keeps a view span and drops a malformed one', () => {
    const m = parseManifest({ ...good, assets: [plate('day'), plate('night', { t0: 'x' })] });
    expect(m.assets[0]!.view).toEqual({ ...span, margin: 0 });
    const withMargin = parseManifest({ ...good, assets: [plate('day', { margin: 0.04 })] });
    expect(withMargin.assets[0]!.view!.margin).toBe(0.04);
    expect(m.assets[1]!.view).toBeUndefined();
  });

  it('viewPlates returns only plates whose span matches the window', async () => {
    const { viewPlates } = await import('./manifest');
    const m = parseManifest({
      ...good,
      assets: [plate('day'), plate('evening', { t0: 0.38 }), plate('night')],
    });
    const plates = viewPlates(m, 'city', 0, 0);
    expect(Object.keys(plates).sort()).toEqual(['day', 'night']);
    expect(plates.day!.id).toBe('view/city/0-0-day');
  });
});
