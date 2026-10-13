import { describe, expect, it } from 'vitest';
import { stepDomAnimations, type SteppableAnimation } from './domCadence';

function anim(playState: AnimationPlayState, currentTime: number | null = 0) {
  const a = {
    playState,
    currentTime,
    pauses: 0,
    pause() {
      this.pauses++;
      this.playState = 'paused';
    },
  };
  return a as SteppableAnimation & { pauses: number; playState: AnimationPlayState };
}

describe('stepDomAnimations — broadcast drives DOM animations at the draw cadence', () => {
  it('pauses a running animation once and then advances it by the drawn frame each call', () => {
    const held = new WeakSet<object>();
    const a = anim('running', 100);
    expect(stepDomAnimations([a], 66.7, held)).toBe(1);
    expect(a.pauses).toBe(1);
    expect(a.playState).toBe('paused');
    expect(a.currentTime).toBeCloseTo(166.7);
    stepDomAnimations([a], 66.7, held);
    expect(a.pauses).toBe(1); // paused once, owned from then on
    expect(a.currentTime).toBeCloseTo(233.4);
  });

  it('leaves an animation someone else paused alone, and skips finished or idle ones', () => {
    const held = new WeakSet<object>();
    const theirs = anim('paused', 50);
    const done = anim('finished', 900);
    const idle = anim('idle', null);
    expect(stepDomAnimations([theirs, done, idle], 66.7, held)).toBe(0);
    expect(theirs.currentTime).toBe(50);
    expect(theirs.pauses).toBe(0);
    expect(done.currentTime).toBe(900);
    expect(idle.currentTime).toBeNull();
  });

  it('treats a null currentTime on a running animation as zero', () => {
    const held = new WeakSet<object>();
    const a = anim('running', null);
    stepDomAnimations([a], 40, held);
    expect(a.currentTime).toBe(40);
  });
});
