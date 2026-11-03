// The musterd voice — the pure half (sound identity, spec 2026-10-28-office-sound-identity-design.md).
//
// The goal bell over the work board rings when a goal ships, and a lane done is one soft ding at the
// closer's desk (goal bell spec 2026-11-03; the shelf chimes are gone). The desk bells carry a
// question, a redirect and a handoff; a small bell above the front door carries arrivals and
// departures. Everything below is the pure half, so the tests hold it without an AudioContext.

/** The goal bell's strike note (C5) and its partials, as multiples of it: a bell's minor-third and
 *  fifth-ish inharmonics over the octave are what make it a bell and not a bar (goal bell spec). */
export const BELL_HZ = 523.25;
export const BELL_PARTIALS: readonly number[] = [1, 2.0, 2.4, 3.0, 4.2];
/** A lane done's ding: one soft note an octave over the bell's strike, its smaller cousin (C6). */
export const DING_HZ = 1046.5;

/** The gestures a stranger needs to tell apart by ear. Every other act folds into the room. */
export type Gesture = 'question' | 'redirect' | 'handoff' | 'arrive';

/** Which gesture an act plays, or null when the office shows it and the eye is enough (§2.4). */
export function gestureFor(act: string): Gesture | null {
  switch (act) {
    case 'ask':
    case 'request_help': return 'question';
    case 'steer':
    case 'challenge':
    case 'decline': return 'redirect';
    case 'handoff': return 'handoff';
    default: return null;
  }
}

/** Per-strike jitter so no two strikes are bit-identical: ±4 cents, ±8% attack gain, ±15% decay. */
export interface Strike {
  freq: number;
  gain: number;
  decay: number;
}
export function jitterStrike(freq: number, gain: number, decay: number, rand: () => number = Math.random): Strike {
  const cents = (rand() * 2 - 1) * 4;
  return {
    freq: freq * Math.pow(2, cents / 1200),
    gain: gain * (1 + (rand() * 2 - 1) * 0.08),
    decay: decay * (1 + (rand() * 2 - 1) * 0.15),
  };
}
