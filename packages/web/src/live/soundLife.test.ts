import { describe, expect, it } from 'vitest';
import { BELL_HZ, BELL_PARTIALS, CHIME_QUEUE_GAP_MS, DING_HZ, chimeDelay, gestureFor, jitterStrike } from './soundLife';

describe('the musterd voice (sound identity spec §2.2–2.4)', () => {
  it('rings the goal bell at C5 with partials up from the strike, and dings a lane an octave over it', () => {
    expect(BELL_HZ).toBeCloseTo(523.25, 2);
    expect(BELL_PARTIALS[0]).toBe(1);
    for (let i = 1; i < BELL_PARTIALS.length; i++) expect(BELL_PARTIALS[i]!).toBeGreaterThan(BELL_PARTIALS[i - 1]!);
    expect(DING_HZ).toBeCloseTo(BELL_HZ * 2, 2);
  });

  it('maps every act to a gesture or to silence; an accept is for the office to show, not a chime', () => {
    expect(gestureFor('accept')).toBeNull();
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

describe('the ding and the bell queue under the moment gate instead of dropping (lane 01M625KHCN)', () => {
  it('a lane done behind another waits a beat; a third waits two; other moments still drop', () => {
    expect(chimeDelay('laneDone', 1000, -Infinity)).toBe(0);
    expect(chimeDelay('laneDone', 1000, 1000)).toBe(CHIME_QUEUE_GAP_MS);
    expect(chimeDelay('goalDone', 1000, 1000 + CHIME_QUEUE_GAP_MS)).toBe(2 * CHIME_QUEUE_GAP_MS);
    expect(chimeDelay('laneDone', 5000, 1000)).toBe(0);
    expect(chimeDelay('question', 1000, 900)).toBeNull();
    expect(chimeDelay('question', 1000, 100)).toBe(0);
  });
});
