import { describe, expect, it } from 'vitest';
import { animFor, gestureFrame } from './character';
import { GESTURE_ANIMS, type SheetSpec } from './rendered/figureSheet';
import { GESTURE, IDLE_GESTURES } from './skeleton';
import type { Pose } from './types';

const anims: SheetSpec['anims'] = {
  idle: { row: 0, frames: 6, fps: 12, loop: true },
  walk: { row: 8, frames: 6, fps: 12, loop: true },
  'sit-type': { row: 16, frames: 4, fps: 12, loop: true },
  'sit-idle': { row: 24, frames: 6, fps: 12, loop: true },
  speak: { row: 32, frames: 6, fps: 12, loop: true },
  turn: { row: 40, frames: 3, fps: 12, loop: false },
  'sit-down': { row: 48, frames: 4, fps: 12, loop: false },
  'stand-up': { row: 56, frames: 4, fps: 12, loop: false },
};

const pose = (p: Partial<Pose>): Pose =>
  ({ lx: 0, ly: 0, dir: 'S', small: false, carry: null, bubble: null, alpha: 1, moving: false, run: false, gesture: 0, gestureT: 0, sit: 0, phase: 0, stride: 0, ...p }) as Pose;

describe('animFor (office realism Task 13: the pose picks the clip)', () => {
  it('walking wins over everything, and the walk is scrubbed by the gait phase (distance, not clock)', () => {
    expect(animFor(pose({ moving: true, sit: 1, bubble: '?' as never }), 1, 5, 0.3, anims).anim).toBe('walk');
    const a = animFor(pose({ moving: true, phase: 0.5 }), 0, 10, 0.3, anims);
    expect(10 - a.startT).toBeCloseTo(0.5 * (6 / 12), 9); // frame 3 of 6
    // the same clock, a different phase: a different frame — the clock alone moves nothing
    expect(animFor(pose({ moving: true, phase: 0.5 }), 0, 11, 0.3, anims).startT).toBeCloseTo(a.startT + 1, 9);
  });

  it('seated with a typing pulse types; seated without it idles', () => {
    expect(animFor(pose({ sit: 1 }), 0.8, 5, 0.3, anims).anim).toBe('sit-type');
    expect(animFor(pose({ sit: 1 }), 0, 5, 0.3, anims).anim).toBe('sit-idle');
  });

  it('a half-sat pose scrubs the sit-down clip by `sit`', () => {
    const a = animFor(pose({ sit: 0.5 }), 0, 10, 0.3, anims);
    expect(a.anim).toBe('sit-down');
    // 4 frames at 12 fps is a third of a second; halfway in is frame 2
    expect(10 - a.startT).toBeCloseTo(0.5 * (4 / 12), 9);
  });

  it('standing with a bubble speaks, otherwise idles — loops start on the seed so idlers are out of phase', () => {
    expect(animFor(pose({ bubble: '!' as never }), 0, 5, 0.3, anims).anim).toBe('speak');
    const a = animFor(pose({}), 0, 5, 0.3, anims);
    const b = animFor(pose({}), 0, 5, 0.7, anims);
    expect(a.anim).toBe('idle');
    expect(a.startT).not.toBe(b.startT);
  });
});

describe('carrying clips (plan Task 16: the hands hold what is carried)', () => {
  const withCarry: SheetSpec['anims'] = {
    ...anims,
    'walk-hold2': { row: 64, frames: 6, fps: 12, loop: true },
    'walk-hold1': { row: 72, frames: 6, fps: 12, loop: true },
    'walk-call': { row: 80, frames: 6, fps: 12, loop: true },
    'idle-hold2': { row: 88, frames: 6, fps: 12, loop: true },
    'idle-hold1': { row: 96, frames: 6, fps: 12, loop: true },
  };

  it('a walker with a box or plate holds it in both hands; a card, mug or bottle in one; the laptop needs neither', () => {
    expect(animFor(pose({ moving: true, carry: 'box' }), 0, 5, 0.3, withCarry).anim).toBe('walk-hold2');
    expect(animFor(pose({ moving: true, carry: 'plate' }), 0, 5, 0.3, withCarry).anim).toBe('walk-hold2');
    expect(animFor(pose({ moving: true, carry: 'card' }), 0, 5, 0.3, withCarry).anim).toBe('walk-hold1');
    expect(animFor(pose({ moving: true, carry: 'laptop' }), 0, 5, 0.3, withCarry).anim).toBe('walk');
    // still scrubbed by the gait phase
    const a = animFor(pose({ moving: true, carry: 'box', phase: 0.5 }), 0, 10, 0.3, withCarry);
    expect(10 - a.startT).toBeCloseTo(0.5 * (6 / 12), 9);
  });

  it('a pacing call walks with the phone at the ear; standing still, a held thing outranks the talking hand', () => {
    expect(animFor(pose({ moving: true, carry: 'phone', gesture: GESTURE.call, gestureT: 0.5 }), 0, 5, 0.3, withCarry).anim).toBe('walk-call');
    expect(animFor(pose({ carry: 'mug', bubble: '!' as never }), 0, 5, 0.3, withCarry).anim).toBe('idle-hold1');
    expect(animFor(pose({ carry: 'box' }), 0, 5, 0.3, withCarry).anim).toBe('idle-hold2');
  });

  it('a sheet from before the carrying clips falls back to the plain walk and idle', () => {
    expect(animFor(pose({ moving: true, carry: 'box' }), 0, 5, 0.3, anims).anim).toBe('walk');
    expect(animFor(pose({ carry: 'card' }), 0, 5, 0.3, anims).anim).toBe('idle');
  });
});

describe('gesture clips (increment 3b: every beat the painter plays has a sprite)', () => {
  // A sheet with every gesture clip, six frames each, at rows past the base clips.
  const withGestures: SheetSpec['anims'] = {
    ...anims,
    ...Object.fromEntries(GESTURE_ANIMS.map((a, i) => [a, { row: 64 + i * 8, frames: 6, fps: 12, loop: false, dirs: ['E', 'S', 'W', 'N'] }])),
  };

  it('every idle gesture maps to a clip the sheet has, in the posture it is played in', () => {
    for (const g of IDLE_GESTURES) {
      const r = animFor(pose({ sit: 1, gesture: g, gestureT: 0.5 }), 0, 5, 0.3, withGestures);
      expect(r.anim.startsWith('g-'), `beat ${g}`).toBe(true);
      expect(withGestures[r.anim], `beat ${g}`).toBeDefined();
      expect(r.frame).toBeGreaterThanOrEqual(0);
    }
  });

  it('the errand beats map too, standing; take is reach played back down', () => {
    for (const g of [GESTURE.browse, GESTURE.fill, GESTURE.pour, GESTURE.call, GESTURE.wave, GESTURE.reach, GESTURE.take]) {
      expect(animFor(pose({ gesture: g, gestureT: 0.5 }), 0, 5, 0.3, withGestures).anim.startsWith('g-')).toBe(true);
    }
    const up = animFor(pose({ gesture: GESTURE.reach, gestureT: 0.9 }), 0, 5, 0.3, withGestures);
    const down = animFor(pose({ gesture: GESTURE.take, gestureT: 0.1 }), 0, 5, 0.3, withGestures);
    expect(down.anim).toBe('g-reach');
    expect(down.frame).toBe(up.frame);
  });

  it('a seated beat on a standing member, a walker, or a sheet without the clip falls back to the base clip', () => {
    expect(animFor(pose({ sit: 0, gesture: GESTURE.lean, gestureT: 0.5 }), 0, 5, 0.3, withGestures).anim).toBe('idle');
    expect(animFor(pose({ moving: true, gesture: GESTURE.call, gestureT: 0.5 }), 0, 5, 0.3, withGestures).anim).toBe('walk');
    expect(animFor(pose({ sit: 1, gesture: GESTURE.sip, gestureT: 0.5 }), 0, 5, 0.3, anims).anim).toBe('sit-idle');
  });

  it('an envelope clip goes rest → peak → rest with the beat; a seq clip walks its window', () => {
    expect(gestureFrame('arc', 0, 6)).toBe(0);
    expect(gestureFrame('arc', 0.5, 6)).toBe(5);
    expect(gestureFrame('arc', 1, 6)).toBe(0);
    expect(gestureFrame('hold', 0.5, 6)).toBe(5);
    expect(gestureFrame('rise', 1, 6)).toBe(5);
    expect(gestureFrame('fall', 1, 6)).toBe(0);
    expect([0, 0.3, 0.6, 0.99].map((g) => gestureFrame('seq', g, 10))).toEqual([0, 3, 6, 9]);
  });
});
