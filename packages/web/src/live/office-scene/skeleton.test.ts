import { describe, expect, it } from 'vitest';
import {
  chairShift,
  chairYaw,
  GESTURE,
  IDLE_GESTURES,
  isIdleGesture,
  handsInLap,
  PULSE_TYPING_PERIOD_S,
  seedOf,
  STRIDE,
  typingBurst,
  typingFromPulse,
} from './skeleton';

/**
 * The beat vocabulary's contract. The rig these beats used to drive (`solveSkeleton`) went with the
 * painted office (lane 01M5D8EJ40); what survives is what the sprite path still leans on — the typing
 * rhythm, the chair curves under a seated beat, and the seam between scheduler beats and errand overlays.
 */

describe('typing', () => {
  it('bursts rather than drumming forever — a member types, then pauses to think', () => {
    const seed = 0.3;
    const samples = Array.from({ length: 400 }, (_, i) => typingBurst(seed, i * 0.05));
    expect(Math.max(...samples)).toBeCloseTo(1, 1); // really types
    expect(samples.some((s) => s === 0)).toBe(true); // really stops
    const duty = samples.filter((s) => s > 0).length / samples.length;
    expect(duty).toBeGreaterThan(0.1);
    expect(duty).toBeLessThan(0.6); // pausing more than typing — it's punctuation, not a metronome
  });

  it('is seeded per member, so a room does not type in unison', () => {
    expect(typingBurst(0.1, 3)).not.toBe(typingBurst(0.8, 3));
  });
});

describe('typing from the pulse (ADR 660)', () => {
  const duty = (intensity: number, seed = 0.3) => {
    const n = 600; // one period at 10 ms
    const samples = Array.from({ length: n }, (_, i) => typingFromPulse(intensity, seed, (i * PULSE_TYPING_PERIOD_S) / n));
    return samples.filter((s) => s > 0).length / n;
  };

  it('never types with no pulse — a hookless or idle seat sits still', () => {
    for (let i = 0; i < 100; i++) expect(typingFromPulse(0, 0.3, i * 0.37)).toBe(0);
  });

  it('types a quarter of the time at one call a minute', () => {
    expect(duty(1)).toBeGreaterThan(0.2);
    expect(duty(1)).toBeLessThan(0.3);
  });

  it('types most of the time at twelve or more', () => {
    expect(duty(12)).toBeGreaterThan(0.8);
    expect(duty(12)).toBeLessThan(0.9);
    expect(duty(40)).toBeCloseTo(duty(12), 2); // capped, not a metronome
  });

  it('still bursts: ramps to full and really stops within a period', () => {
    const samples = Array.from({ length: 600 }, (_, i) => typingFromPulse(6, 0.3, i * 0.01));
    expect(Math.max(...samples)).toBeCloseTo(1, 1);
    expect(samples.some((s) => s === 0)).toBe(true);
  });

  it('is phase-seeded per member', () => {
    const diff = Array.from({ length: 50 }, (_, i) => i * 0.11).filter(
      (t) => typingFromPulse(4, 0.1, t) !== typingFromPulse(4, 0.8, t),
    );
    expect(diff.length).toBeGreaterThan(25);
  });
});

describe('seated micro-beats', () => {
  it('chair curves are zero at both ends and move mid-window', () => {
    expect(chairShift(GESTURE.roll, 0)).toBeCloseTo(0, 6);
    expect(chairShift(GESTURE.roll, 1)).toBeCloseTo(0, 6);
    expect(chairShift(GESTURE.roll, 0.5)).toBeGreaterThan(8);
    expect(chairYaw(GESTURE.swivel, 0)).toBeCloseTo(0, 6);
    expect(chairYaw(GESTURE.swivel, 1)).toBeCloseTo(0, 6);
    expect(Math.abs(chairYaw(GESTURE.swivel, 1 / 6))).toBeGreaterThan(0.05);
    // …and only their own beats move them
    expect(chairShift(GESTURE.sip, 0.5)).toBe(0);
    expect(chairYaw(GESTURE.lean, 0.5)).toBe(0);
  });

  it('flags hands-in-lap only while a lap beat is actually engaged', () => {
    expect(handsInLap(GESTURE.lean, 0.5)).toBe(true);
    expect(handsInLap(GESTURE.roll, 0.5)).toBe(true);
    expect(handsInLap(GESTURE.lean, 0)).toBe(false);
    expect(handsInLap(GESTURE.roll, 1)).toBe(false);
    expect(handsInLap(GESTURE.sip, 0.5)).toBe(false);
    expect(handsInLap(GESTURE.swivel, 0.5)).toBe(false);
  });
});

describe('rig invariants', () => {
  it('seeds deterministically per name — a member looks the same across reloads', () => {
    expect(seedOf('miley')).toBe(seedOf('miley'));
    expect(seedOf('miley')).not.toBe(seedOf('izzo'));
  });

  it('has a stride long enough to be a step, not a shuffle', () => {
    // a thigh is ~17 floor units; a stride shorter than that is a shuffle
    expect(STRIDE).toBeGreaterThan(17);
  });
});

/**
 * The scheduler's beats and the errand overlays are two families in one registry, and only
 * `IDLE_GESTURES` separates them. #1434 keyed `GESTURE_DUR` by `IdleGesture` and dropped its
 * `?? 2.4` fallback — correct, because a table that cannot report its own gaps is how four beats
 * shipped on the shortest window in it. But the guard has to reach the ONE caller that takes a
 * number from outside the type system: `pokeGesture`, fed a URL param by `/office-preview?beat=`.
 * Without it an errand id reached `gestureBeat` with no window at all, `g.t >= g.dur` was never
 * true against `undefined`, and that member gestured for the life of the scene (izzo, reviewing
 * #1434: red on the branch, green on main).
 */
describe('isIdleGesture — the boundary between scheduler beats and errand overlays', () => {
  it('accepts every beat the scheduler can pick, including the four #1430 added', () => {
    for (const kind of IDLE_GESTURES) expect(isIdleGesture(kind)).toBe(true);
    for (const kind of [GESTURE.shoulders, GESTURE.behindHead, GESTURE.rubEyes, GESTURE.pocketPhone])
      expect(isIdleGesture(kind)).toBe(true);
  });

  it('rejects the errand overlays, which have no scheduler window and never did', () => {
    for (const kind of [GESTURE.browse, GESTURE.fill, GESTURE.eat, GESTURE.pour, GESTURE.call])
      expect(isIdleGesture(kind)).toBe(false);
  });

  it('rejects a number that is no beat at all — the URL param case', () => {
    for (const n of [0, 99, -1, 1.5, Number.NaN]) expect(isIdleGesture(n)).toBe(false);
  });
});

describe('the welcome wave gesture (lane 01M3F81DD9)', () => {
  it('exists, and the ambient scheduler can never pick it', () => {
    expect(GESTURE.wave).toBe(19);
    expect(IDLE_GESTURES).not.toContain(GESTURE.wave);
  });
});
