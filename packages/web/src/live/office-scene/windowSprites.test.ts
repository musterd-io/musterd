import { describe, expect, it } from 'vitest';
import { computeLightEnv } from './lighting';
import { drawMovers, moversAt, moversMove } from './windowSprites';

const T0 = 1_800_000_000_000;
const at = (h: number) => computeLightEnv(h, true);

describe('moversAt (window views, lane 01M6ENGW2H)', () => {
  it('the sun rises at 6 and sets at 19', () => {
    expect(moversAt('city', T0, at(5.5), 'clear', 'revive').filter((m) => m.kind === 'sun')).toHaveLength(0);
    const noon = moversAt('city', T0, at(12), 'clear', 'revive').filter((m) => m.kind === 'sun');
    expect(noon.length).toBeGreaterThan(0);
    expect(noon[0]!.x).toBeCloseTo(0.46, 1);
    expect(moversAt('city', T0, at(19.5), 'clear', 'revive').filter((m) => m.kind === 'sun')).toHaveLength(0);
  });

  it('stars are out at night only', () => {
    expect(moversAt('city', T0, at(23), 'clear', 'revive').some((m) => m.kind === 'star')).toBe(true);
    expect(moversAt('city', T0, at(12), 'clear', 'revive').some((m) => m.kind === 'star')).toBe(false);
  });

  it('a tram is deterministic per team and slot', () => {
    const a = moversAt('city', T0 + 90_000, at(12), 'clear', 'revive').filter((m) => m.kind === 'tram');
    const b = moversAt('city', T0 + 90_000, at(12), 'clear', 'revive').filter((m) => m.kind === 'tram');
    expect(a).toEqual(b);
    // over a day of slots a tram does come by
    let seen = 0;
    for (let k = 0; k < 480; k++)
      if (moversAt('city', T0 + k * 180_000, at(12), 'clear', 'revive').some((m) => m.kind === 'tram')) seen++;
    expect(seen).toBeGreaterThan(50);
    expect(seen).toBeLessThan(480);
  });

  it('no plane in rain, no sun in snow', () => {
    for (let k = 0; k < 200; k++) {
      const ms = moversAt('city', T0 + k * 300_000, at(18.5), 'rain', 'revive');
      expect(ms.some((m) => m.kind === 'plane')).toBe(false);
    }
    expect(moversAt('city', T0, at(12), 'snow', 'revive').some((m) => m.kind === 'sun')).toBe(false);
  });

  it('coast and mountain have no tram', () => {
    for (let k = 0; k < 100; k++) {
      expect(moversAt('coast', T0 + k * 180_000, at(12), 'clear', 'revive').some((m) => m.kind === 'tram')).toBe(false);
      expect(moversAt('mountain', T0 + k * 180_000, at(12), 'clear', 'revive').some((m) => m.kind === 'tram')).toBe(false);
    }
  });

  it('moversMove says whether anything is in motion', () => {
    expect(moversMove(moversAt('city', T0, at(12), 'clear', 'revive'))).toBe(true); // clouds drift
    expect(moversMove([])).toBe(false);
  });

  it('drawMovers clips every mover to its pane', async () => {
    const { fitFloor } = await import('./iso');
    const { recordingCtx } = await import('./recording-ctx');
    const { ctx, ops } = recordingCtx();
    const ms = moversAt('city', T0, at(12), 'clear', 'revive');
    drawMovers(ctx, fitFloor(1200, 900), ms);
    expect(ops.filter((o) => o.name === 'clip').length).toBe(ms.length);
  });
});
