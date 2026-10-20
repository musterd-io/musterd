import { describe, expect, it } from 'vitest';
import { laneUnboundAck } from './lanes.js';

describe('laneUnboundAck (ADR 679)', () => {
  it('says the reply bound to nothing, and names the lane’s state', () => {
    const ack = laneUnboundAck({
      lane: 'L1',
      ask: 'A-old',
      verdict: 'decline',
      state: 'done',
    });
    expect(ack).toMatchObject({
      lane: 'L1',
      ask: 'A-old',
      verdict: 'decline',
      state: 'done',
    });
    expect(ack.guidance).toContain('Lane L1');
    expect(ack.guidance).toContain('bound to nothing');
    expect(ack.guidance).toContain('the lane is done');
    expect(ack.guidance).toContain('only a lane awaiting acceptance is moved by a verdict');
    // The reply is not lost: the row is on the lane, so its owner sees who spoke.
    expect(ack.guidance).toContain('recorded against the lane');
  });

  it('names a `wait` as a wait, and a lane sent back as active', () => {
    const ack = laneUnboundAck({ lane: 'L2', ask: 'A-1', verdict: 'wait', state: 'active' });
    expect(ack.guidance).toContain('your wait');
    expect(ack.guidance).toContain('the lane is active');
  });
});
