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

  it('rain hides the moon and the stars; a clear night shows both (inc 3)', () => {
    const kinds = (w: 'clear' | 'rain' | 'cloudy') => new Set(moversAt('city', T0, at(23), w, 'revive').map((m) => m.kind));
    expect(kinds('clear').has('moon')).toBe(true);
    expect(kinds('clear').has('star')).toBe(true);
    expect(kinds('rain').has('moon')).toBe(false);
    expect(kinds('rain').has('star')).toBe(false);
    expect(kinds('cloudy').has('star')).toBe(false);
  });

  it('clouds take the night: white at noon, shaded after dark (inc 3)', () => {
    const shade = (h: number) => moversAt('city', T0, at(h), 'clear', 'revive').find((m) => m.kind === 'cloud')!.shade ?? 0;
    expect(shade(12)).toBe(0);
    expect(shade(23)).toBeGreaterThan(0.6);
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

  describe('increment 2 (lane 01M6ENH3T5): the coast and the mountain have their own movers', () => {
    it('the beacon flashes at night only', () => {
      // 0.3 s on in every 4 s: within one 4 s slot some instants are lit and the rest are dark
      const lit = (h: number) => {
        let on = 0;
        for (let k = 0; k < 40; k++)
          if (moversAt('coast', T0 + k * 100, at(h), 'clear', 'revive').some((m) => m.kind === 'beacon')) on++;
        return on;
      };
      expect(lit(23)).toBeGreaterThan(0);
      expect(lit(23)).toBeLessThan(40);
      expect(lit(12)).toBe(0);
      expect(moversAt('city', T0, at(23), 'clear', 'revive').some((m) => m.kind === 'beacon')).toBe(false);
    });

    it('no gulls in rain', () => {
      let clear = 0;
      for (let k = 0; k < 200; k++) {
        clear += moversAt('coast', T0 + k * 2_000, at(12), 'clear', 'revive').filter((m) => m.kind === 'gull').length;
        expect(moversAt('coast', T0 + k * 2_000, at(12), 'rain', 'revive').some((m) => m.kind === 'gull')).toBe(false);
        expect(moversAt('coast', T0 + k * 2_000, at(23), 'clear', 'revive').some((m) => m.kind === 'gull')).toBe(false);
      }
      expect(clear).toBeGreaterThan(0);
    });

    it('a boat crosses the horizon in its slot, deterministic per team', () => {
      let seen = 0;
      for (let k = 0; k < 360; k++) {
        const ms = moversAt('coast', T0 + k * 240_000, at(12), 'clear', 'revive').filter((m) => m.kind === 'boat');
        expect(ms).toEqual(moversAt('coast', T0 + k * 240_000, at(12), 'clear', 'revive').filter((m) => m.kind === 'boat'));
        for (const b of ms) expect(b.y).toBeCloseTo(0.62, 2);
        if (ms.length) seen++;
      }
      expect(seen).toBeGreaterThan(50);
      expect(seen).toBeLessThan(360);
    });

    it('the hawk circles by day', () => {
      const a = moversAt('mountain', T0, at(12), 'clear', 'revive').filter((m) => m.kind === 'hawk');
      const b = moversAt('mountain', T0 + 10_000, at(12), 'clear', 'revive').filter((m) => m.kind === 'hawk');
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]!.x).not.toBeCloseTo(b[0]!.x, 3);
      expect(moversAt('mountain', T0, at(23), 'clear', 'revive').some((m) => m.kind === 'hawk')).toBe(false);
      expect(moversAt('coast', T0, at(12), 'clear', 'revive').some((m) => m.kind === 'hawk')).toBe(false);
    });

    it('the cabin glows at night only', () => {
      expect(moversAt('mountain', T0, at(23), 'clear', 'revive').some((m) => m.kind === 'cabin')).toBe(true);
      expect(moversAt('mountain', T0, at(12), 'clear', 'revive').some((m) => m.kind === 'cabin')).toBe(false);
    });

    it('every new mover draws inside its clip', async () => {
      const { fitFloor } = await import('./iso');
      const { recordingCtx } = await import('./recording-ctx');
      for (const [view, h, t] of [['coast', 12, 0], ['coast', 23, 100], ['mountain', 12, 0], ['mountain', 23, 0]] as const) {
        const { ctx, ops } = recordingCtx();
        const ms = moversAt(view, T0 + t, at(h), 'clear', 'revive');
        drawMovers(ctx, fitFloor(1200, 900), ms);
        expect(ops.filter((o) => o.name === 'clip').length).toBe(ms.length);
      }
    });
  });

  it('moversMove says whether anything is in motion', () => {
    expect(moversMove(moversAt('city', T0, at(12), 'clear', 'revive'))).toBe(true); // clouds drift
    expect(moversMove([])).toBe(false);
  });

  it('drawMovers clips every mover to the glass between the mullions, never the frame (review I1)', async () => {
    const { fitFloor } = await import('./iso');
    const { recordingCtx } = await import('./recording-ctx');
    const { WINDOWS } = await import('./layout');
    const { ctx, ops } = recordingCtx();
    const ms = moversAt('city', T0, at(12), 'clear', 'revive');
    drawMovers(ctx, fitFloor(1200, 900), ms);
    expect(ops.filter((o) => o.name === 'clip').length).toBe(ms.length);
    // one sub-rect per glass light: a window with N mullion divisions has N lights
    const lights = ms.reduce((n, m) => n + WINDOWS[m.i]!.mullions, 0);
    expect(ops.filter((o) => o.name === 'moveTo').length).toBe(lights);
  });
});
