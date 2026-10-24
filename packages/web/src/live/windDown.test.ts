import { describe, expect, it } from 'vitest';
import { nextRedrawMs, windDownView, WIND_DOWN_MS } from './windDown';

const NOW = 1_787_000_000_000;

describe('windDownView', () => {
  it('says nothing when no stop is queued or the deadline has passed', () => {
    expect(windDownView('acme', null, NOW)).toBeNull();
    expect(windDownView('acme', NOW, NOW)).toBeNull();
  });

  it('names the team and rounds the minutes up', () => {
    const v = windDownView('acme', NOW + WIND_DOWN_MS, NOW)!;
    expect(v.text).toBe('team acme will be ending its day in 30 minutes');
    expect(v.daylight).toBe(1);
    expect(windDownView('acme', NOW + 4 * 60_000 + 1, NOW)!.text).toContain('in 5 minutes');
    expect(windDownView('acme', NOW + 30_000, NOW)!.text).toContain('in a minute');
  });

  it('lowers the sun as the deadline nears', () => {
    expect(windDownView('acme', NOW + WIND_DOWN_MS / 2, NOW)!.daylight).toBeCloseTo(0.5);
  });
});

describe('nextRedrawMs', () => {
  it('redraws on the five-minute boundary early, every minute in the last five', () => {
    expect(nextRedrawMs(NOW + 27 * 60_000, NOW)).toBe(2 * 60_000);
    expect(nextRedrawMs(NOW + 4 * 60_000 + 20_000, NOW)).toBe(20_000);
  });
});
