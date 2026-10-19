import { describe, expect, it } from 'vitest';
import { PULSE_TTL_MS, pulseIntensity, pulseLive, runGlow, type SeatPulse } from './pulse';

const at = (ts: number, over: Partial<SeatPulse> = {}): SeatPulse => ({
  ts,
  intensity: 4,
  kind: 'edit',
  last_ts: ts,
  ...over,
});

describe('pulseIntensity / pulseLive (ADR 660 §3.3)', () => {
  it('reports the frame intensity while the pulse is live', () => {
    expect(pulseIntensity(at(0), PULSE_TTL_MS - 1)).toBe(4);
    expect(pulseLive(at(0), PULSE_TTL_MS - 1)).toBe(true);
  });

  it('is zero exactly at the TTL and after — three missed pulses means still', () => {
    expect(pulseIntensity(at(0), PULSE_TTL_MS)).toBe(0);
    expect(pulseLive(at(0), PULSE_TTL_MS)).toBe(false);
    expect(pulseIntensity(at(0), PULSE_TTL_MS * 10)).toBe(0);
  });

  it('is zero with no pulse at all — a hookless seat sits still', () => {
    expect(pulseIntensity(undefined, 1_000)).toBe(0);
    expect(pulseLive(undefined, 1_000)).toBe(false);
  });

  it('a live frame with intensity 0 is not live — silence is the idle signal', () => {
    expect(pulseLive(at(0, { intensity: 0 }), 10)).toBe(false);
  });
});

describe('runGlow', () => {
  it('is full at the run, half-way at 1.5 s, gone at 3 s', () => {
    const p = at(0, { kind: 'run', last_ts: 10_000 });
    expect(runGlow(p, 10_000)).toBe(1);
    expect(runGlow(p, 11_500)).toBeCloseTo(0.5, 5);
    expect(runGlow(p, 13_000)).toBe(0);
    expect(runGlow(p, 20_000)).toBe(0);
  });

  it('only a run glows', () => {
    expect(runGlow(at(0, { kind: 'edit', last_ts: 0 }), 0)).toBe(0);
    expect(runGlow(at(0, { kind: 'read', last_ts: 0 }), 0)).toBe(0);
    expect(runGlow(at(0, { kind: null, last_ts: 0 }), 0)).toBe(0);
    expect(runGlow(undefined, 0)).toBe(0);
  });

  it('never glows from the future (clock skew between producer and viewer)', () => {
    expect(runGlow(at(0, { kind: 'run', last_ts: 5_000 }), 1_000)).toBe(1);
  });
});
