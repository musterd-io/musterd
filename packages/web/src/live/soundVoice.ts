// The musterd voice — the pure half (sound identity, spec 2026-10-28-office-sound-identity-design.md).
//
// One instrument and five gestures. The shelf chimes by the work board ring for finished work; the
// desk bells carry a question, a redirect and a handoff; a small cousin of the chimes above the
// front door carries arrivals and departures. Everything below is the pure half — which bar, how many
// voices, when each strikes — so the tests hold it without an AudioContext. The engine only plays it.

/** The eight bars of the shelf chimes: C major pentatonic from C4, one note each. Any bars struck
 *  together are consonant, so a busy day cannot play a wrong note. */
export const CHIME_BARS: readonly number[] = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

/** The five gestures a stranger needs to tell apart by ear. Every other act folds into the room. */
export type Gesture = 'done' | 'question' | 'redirect' | 'handoff' | 'arrive';

/** Which gesture an act plays, or null when the office shows it and the eye is enough (§2.4). */
export function gestureFor(act: string): Gesture | null {
  switch (act) {
    case 'accept': return 'done';
    case 'ask':
    case 'request_help': return 'question';
    case 'steer':
    case 'challenge':
    case 'decline': return 'redirect';
    case 'handoff': return 'handoff';
    default: return null;
  }
}

/** The bar a lane rings: a stable hash of its id onto the eight, so the same lane always rings the
 *  same note and a day of shipped lanes plays a slow melody nobody composed. */
export function barForLane(laneId: string): number {
  let h = 2166136261;
  for (let i = 0; i < laneId.length; i++) {
    h ^= laneId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % CHIME_BARS.length;
}

/** How many bars a lane done rings: one per distinct seat in its chain (requested-by, owner,
 *  acceptor), 1 to 3. A chain the client cannot see rings one voice (§6.1). */
export function voicesForChain(seats: ReadonlyArray<string | null | undefined>): number {
  const distinct = new Set(seats.filter((s): s is string => typeof s === 'string' && s.length > 0));
  return Math.max(1, Math.min(3, distinct.size));
}

/** The bars a chord strikes: the lane's bar and the next ones up the scale, folding back down when
 *  the top runs out, so a chord never leaves the eight. */
export function chordBars(bar: number, voices: number): number[] {
  const top = CHIME_BARS.length - 1;
  const start = Math.min(bar, top - (voices - 1));
  return Array.from({ length: voices }, (_, i) => start + i);
}

/** When each bar of a chord strikes, seconds after the first: 15–40 ms apart, rolled upward. */
export function chordOffsets(voices: number, rand: () => number = Math.random): number[] {
  const out = [0];
  for (let i = 1; i < voices; i++) out.push(out[i - 1]! + 0.015 + rand() * 0.025);
  return out;
}

/** When each bar of the goal roll strikes, seconds after the first: all eight, bottom to top,
 *  60–90 ms apart. The only time all eight sound. */
export function rollOffsets(rand: () => number = Math.random): number[] {
  const out = [0];
  for (let i = 1; i < CHIME_BARS.length; i++) out.push(out[i - 1]! + 0.06 + rand() * 0.03);
  return out;
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
