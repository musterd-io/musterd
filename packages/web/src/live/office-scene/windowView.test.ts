import { describe, expect, it } from 'vitest';
import { fitFloor } from './iso';
import { WINDOWS } from './layout';
import { computeLightEnv } from './lighting';
import { recordingCtx } from './recording-ctx';
import type { RenderedAssets } from './rendered/assets';
import { parseManifest } from './rendered/manifest';
import { drawWindowViews, paneQuad, plateTint, skyStops, viewOverride } from './windowView';

const fit = fitFloor(1200, 900);
const camera = { kx: 0.70710678, ky: 0.33729 };

function art(assets: Record<string, unknown>[] = []): RenderedAssets {
  const manifest = parseManifest({ version: 1, camera, assets });
  const images = new Map<string, CanvasImageSource>();
  for (const a of manifest.assets) images.set(a.id, {} as CanvasImageSource);
  return { manifest, images, missing: [] };
}

function cityPlates(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const which of [0, 1] as const)
    for (const [i, w] of WINDOWS.entries())
      for (const state of ['day', 'evening', 'night'])
        out.push({
          id: `view/city/${which}-${i}-${state}`,
          file: `office-art-view-city-${which}-${i}-${state}.webp`,
          w: 300,
          h: 420,
          anchor: { x: 0, y: 0 },
          scale: 3,
          view: { which, t0: w.t0, t1: w.t1, u0: w.u0, u1: w.u1 },
        });
  return out;
}

describe('skyStops (window views, lane 01M6ENGW2H)', () => {
  it('is night at 23.5 and day at 12', () => {
    expect(skyStops(12, 'clear')).toEqual(['rgb(84,158,236)', 'rgb(198,226,246)']);
    expect(skyStops(23.5, 'clear')).toEqual(['rgb(13,19,46)', 'rgb(31,39,74)']);
  });

  it('under snow is paler than clear at noon', () => {
    const clear = skyStops(12, 'clear');
    const snow = skyStops(12, 'snow');
    const lum = (c: string) => c.match(/\d+/g)!.map(Number).reduce((a, b) => a + b, 0);
    expect(lum(snow[0])).toBeGreaterThan(lum(clear[0]));
  });
});

describe('plateTint', () => {
  it('maps the four weathers', () => {
    expect(plateTint('clear')).toEqual({ brightness: 1, saturate: 1 });
    expect(plateTint('cloudy').saturate).toBeLessThan(1);
    expect(plateTint('rain').brightness).toBeLessThan(plateTint('cloudy').brightness);
    expect(plateTint('snow').brightness).toBeGreaterThan(plateTint('rain').brightness);
  });
});

describe('paneQuad', () => {
  it('is the four corners of the pane on its wall, bottom-left first', () => {
    const q = paneQuad(fit, 0, 0);
    expect(q).toHaveLength(4);
    // bottom-left and top-left share x; top is above bottom (smaller y)
    expect(q[0].x).toBeCloseTo(q[3].x);
    expect(q[3].y).toBeLessThan(q[0].y);
  });
});

describe('drawWindowViews', () => {
  it('with no plates still clips and fills each pane (a sky, never a hole)', () => {
    const { ctx, ops } = recordingCtx();
    drawWindowViews(ctx, fit, computeLightEnv(12, true), art(), 'clear', 'city');
    expect(ops.filter((o) => o.name === 'clip')).toHaveLength(4);
    expect(ops.filter((o) => o.name === 'fill').length).toBeGreaterThanOrEqual(4);
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(0);
  });

  it('with plates draws from and to at the fade', () => {
    const { ctx, ops } = recordingCtx();
    drawWindowViews(ctx, fit, computeLightEnv(16.75, true), art(cityPlates()), 'clear', 'city');
    expect(ops.filter((o) => o.name === 'drawImage')).toHaveLength(8);
    const alphas = ops.filter((o) => o.name === 'set:globalAlpha').map((o) => o.args[0] as number);
    expect(alphas.some((a) => Math.abs(a - 1 / 3) < 0.01)).toBe(true);
  });
});

describe('viewOverride', () => {
  it('reads ?view= and ignores junk', () => {
    expect(viewOverride('?view=coast')).toBe('coast');
    expect(viewOverride('?view=MOUNTAIN')).toBe('mountain');
    expect(viewOverride('?view=mars')).toBeNull();
    expect(viewOverride('')).toBeNull();
  });
});
