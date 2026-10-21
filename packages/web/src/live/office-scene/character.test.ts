import { describe, expect, it } from 'vitest';
import { animFor } from './character';
import type { AnimSpec, Anim } from './rendered/figureSheet';
import type { Pose } from './types';

const anims: Record<Anim, AnimSpec> = {
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
