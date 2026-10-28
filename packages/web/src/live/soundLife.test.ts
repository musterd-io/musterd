import { describe, expect, it } from 'vitest';
import {
  CHIME_BARS,
  CHIME_QUEUE_GAP_MS,
  chimeDelay,
  barForLane,
  chordBars,
  chordOffsets,
  gestureFor,
  jitterStrike,
  rollOffsets,
  voicesForChain,
} from './soundLife';

describe('the musterd voice (sound identity spec §2.2–2.4)', () => {
  it('has eight pentatonic bars rising from C4', () => {
    expect(CHIME_BARS).toHaveLength(8);
    for (let i = 1; i < CHIME_BARS.length; i++) expect(CHIME_BARS[i]!).toBeGreaterThan(CHIME_BARS[i - 1]!);
    expect(CHIME_BARS[0]).toBeCloseTo(261.63, 1);
  });

  it('maps every act to one of five gestures or to silence', () => {
    expect(gestureFor('accept')).toBe('done');
    expect(gestureFor('ask')).toBe('question');
    expect(gestureFor('request_help')).toBe('question');
    expect(gestureFor('steer')).toBe('redirect');
    expect(gestureFor('challenge')).toBe('redirect');
    expect(gestureFor('decline')).toBe('redirect');
    expect(gestureFor('handoff')).toBe('handoff');
    for (const folded of ['message', 'status_update', 'wait', 'defer', 'resolve', 'end', 'insight']) {
      expect(gestureFor(folded)).toBeNull();
    }
  });

  it('rings the same bar for the same lane, and spreads lanes across the eight', () => {
    expect(barForLane('01M61R493R3PE8EMD2JTVBJWF4')).toBe(barForLane('01M61R493R3PE8EMD2JTVBJWF4'));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(barForLane(`01M61R4${i.toString(36).padStart(19, '0')}`));
    expect(seen.size).toBe(8);
    for (const b of seen) expect(b).toBeGreaterThanOrEqual(0);
  });

  it('sizes the chord by distinct seats in the chain, one to three', () => {
    expect(voicesForChain([])).toBe(1);
    expect(voicesForChain([null, undefined, ''])).toBe(1);
    expect(voicesForChain(['nick', 'miley', 'miley'])).toBe(2);
    expect(voicesForChain(['nick', 'miley', 'izzo'])).toBe(3);
    expect(voicesForChain(['nick', 'miley', 'izzo', 'dolly'])).toBe(3);
  });

  it('builds a chord upward and folds it down at the top so it never leaves the eight', () => {
    expect(chordBars(2, 3)).toEqual([2, 3, 4]);
    expect(chordBars(7, 1)).toEqual([7]);
    expect(chordBars(7, 3)).toEqual([5, 6, 7]);
    expect(chordBars(6, 2)).toEqual([6, 7]);
  });

  it('rolls a chord 15–40 ms apart and the goal 60–90 ms apart, all eight', () => {
    const lo = chordOffsets(3, () => 0);
    const hi = chordOffsets(3, () => 1);
    expect(lo).toEqual([0, 0.015, 0.03]);
    expect(hi[2]).toBeCloseTo(0.08, 5);
    expect(rollOffsets(() => 0)).toHaveLength(8);
    expect(rollOffsets(() => 0)[7]).toBeCloseTo(0.42, 5);
    expect(rollOffsets(() => 1)[7]).toBeCloseTo(0.63, 5);
  });

  it('jitters every strike within ±4 cents, ±8% gain, ±15% decay', () => {
    const up = jitterStrike(440, 0.03, 2, () => 1);
    const down = jitterStrike(440, 0.03, 2, () => 0);
    expect(up.freq / 440).toBeCloseTo(Math.pow(2, 4 / 1200), 6);
    expect(down.freq / 440).toBeCloseTo(Math.pow(2, -4 / 1200), 6);
    expect(up.gain).toBeCloseTo(0.0324, 6);
    expect(down.decay).toBeCloseTo(1.7, 6);
    expect(jitterStrike(440, 0.03, 2, () => 0.5)).toEqual({ freq: 440, gain: 0.03, decay: 2 });
  });
});

describe('the chimes queue under the moment gate instead of dropping (lane 01M625KHCN)', () => {
  it('a lane done behind another waits a beat; a third waits two; other moments still drop', () => {
    expect(chimeDelay('laneDone', 1000, -Infinity)).toBe(0);
    expect(chimeDelay('laneDone', 1000, 1000)).toBe(CHIME_QUEUE_GAP_MS);
    expect(chimeDelay('goalDone', 1000, 1000 + CHIME_QUEUE_GAP_MS)).toBe(2 * CHIME_QUEUE_GAP_MS);
    expect(chimeDelay('laneDone', 5000, 1000)).toBe(0);
    expect(chimeDelay('question', 1000, 900)).toBeNull();
    expect(chimeDelay('question', 1000, 100)).toBe(0);
  });
});
