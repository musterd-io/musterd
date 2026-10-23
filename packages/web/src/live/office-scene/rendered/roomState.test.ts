import { describe, expect, it } from 'vitest';
import { computeLightEnv } from '../lighting';
import { DAY_EDGES, FADE_HOURS, ceilingStateFor, figureTintFor, isRoomImage, roomImagesWanted, roomMixFor } from './roomState';

const at = (h: number, occupied = true, inShift: boolean | null = null) => computeLightEnv(h, occupied, inShift);

describe('roomMixFor (office realism Task 8: light states and the 45-minute crossfade)', () => {
  it('is day-on at noon with the ceiling on, mix 0', () => {
    expect(roomMixFor(at(12))).toEqual({ from: 'day-on', to: 'day-on', mix: 0 });
  });

  it('holds day until the evening edge', () => {
    expect(roomMixFor(at(16.5))).toEqual({ from: 'day-on', to: 'day-on', mix: 0 });
    expect(roomMixFor(at(16.49)).mix).toBe(0);
  });

  it('is halfway from day to evening at 16:52:30 and done by 17:15', () => {
    const half = roomMixFor(at(16 + 52.5 / 60));
    expect(half.from).toBe('day-on');
    expect(half.to).toBe('evening-on');
    expect(half.mix).toBeCloseTo(0.5, 6);
    const done = roomMixFor(at(17.25));
    expect(done.mix === 1 || done.from === done.to).toBe(true);
    expect(done.to).toBe('evening-on');
    expect(roomMixFor(at(18)).from).toBe('evening-on');
  });

  it('goes evening → night at 19:00 and night → day at 07:00', () => {
    expect(roomMixFor(at(19.3))).toMatchObject({ from: 'evening-on', to: 'night-on' });
    expect(roomMixFor(at(23)).from).toBe('night-on');
    expect(roomMixFor(at(3)).from).toBe('night-on');
    expect(roomMixFor(at(7.3))).toMatchObject({ from: 'night-on', to: 'day-on' });
    expect(roomMixFor(at(9)).from).toBe('day-on');
  });

  it('the ceiling follows the env: on, off when empty, spill after hours', () => {
    expect(ceilingStateFor(at(12, true))).toBe('on');
    expect(ceilingStateFor(at(12, false))).toBe('off');
    expect(ceilingStateFor(at(21, true, false))).toBe('spill');
    expect(roomMixFor(at(21, true, false)).from).toBe('night-spill');
    expect(roomMixFor(at(21, false)).from).toBe('night-off');
  });

  it('never steps the mix by more than one minute of the fade per simulated minute (continuity)', () => {
    // The room's position on the day cycle: day 0 → evening 1 → night 2 → day 3 (= 0). A fade is
    // a straight line between two integers; a pop is a jump of more than one minute's worth.
    const idx = { day: 0, evening: 1, night: 2 } as const;
    const pos = (m: ReturnType<typeof roomMixFor>) => {
      const f = idx[m.from.split('-')[0] as keyof typeof idx];
      return m.from === m.to ? f : f + m.mix;
    };
    let prev = roomMixFor(at(0));
    for (let m = 1; m <= 24 * 60; m++) {
      const cur = roomMixFor(at(m / 60));
      const raw = Math.abs(pos(cur) - pos(prev));
      const step = Math.min(raw, 3 - raw); // the cycle wraps night → day
      // a fade is FADE_HOURS long, so one minute moves the mix by at most 1/(FADE_HOURS*60)
      expect(step).toBeLessThanOrEqual(1 / (FADE_HOURS * 60) + 1e-9);
      // outside a fade the mix is exactly 0 — never a stuck half-blend
      if (cur.from === cur.to) expect(cur.mix).toBe(0);
      prev = cur;
    }
  });

  it('the ?light= override is the same clock: computeLightEnv(hours) feeds it', () => {
    expect(roomMixFor(computeLightEnv(17, true))).toEqual(roomMixFor(at(17)));
    expect(DAY_EDGES).toEqual({ dayFrom: 7, eveningFrom: 16.5, nightFrom: 19 });
  });
});

describe('figureTintFor', () => {
  it('is white by day and a cool multiply at night, with no pop at the edges', () => {
    expect(figureTintFor(at(12))).toBe('#ffffff');
    expect(figureTintFor(at(23))).not.toBe('#ffffff');
    let prev = figureTintFor(at(0));
    for (let m = 1; m <= 24 * 60; m += 5) {
      const cur = figureTintFor(at(m / 60));
      const d = Math.max(
        ...[1, 3, 5].map((i) => Math.abs(parseInt(cur.slice(i, i + 2), 16) - parseInt(prev.slice(i, i + 2), 16))),
      );
      expect(d).toBeLessThanOrEqual(12);
      prev = cur;
    }
  });
});

describe('roomImagesWanted (lane 01M5D8EJ40: only the light states in view, ~9 MB each decoded)', () => {
  it('at noon with people in: the day shell and the ceiling — not evening, not night', () => {
    expect([...roomImagesWanted(at(12))].sort()).toEqual(['room/ceiling-on', 'room/light-day']);
  });

  it('within half an hour of a fade, the next shell is already wanted', () => {
    expect(roomImagesWanted(at(16.1)).has('room/light-evening')).toBe(true);
    expect(roomImagesWanted(at(15.5)).has('room/light-evening')).toBe(false);
  });

  it('mid-fade: both sides of it', () => {
    const w = roomImagesWanted(at(DAY_EDGES.eveningFrom + FADE_HOURS / 2));
    expect(w.has('room/light-day')).toBe(true);
    expect(w.has('room/light-evening')).toBe(true);
  });

  it('wraps past midnight: late night looks ahead to the small hours, still night', () => {
    expect([...roomImagesWanted(at(23.8, false))].filter((id) => id.startsWith('room/light-'))).toEqual(['room/light-night']);
  });

  it('an empty room has no ceiling overlay to keep', () => {
    expect([...roomImagesWanted(at(12, false))].some((id) => id.startsWith('room/ceiling-'))).toBe(false);
  });

  it('isRoomImage names the full-room images and nothing else', () => {
    expect(['room/light-day', 'room/ceiling-spill', 'desk/base', 'rug/nook'].map(isRoomImage)).toEqual([true, true, false, false]);
  });
});
