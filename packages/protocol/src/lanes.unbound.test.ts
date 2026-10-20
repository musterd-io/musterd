import { describe, expect, it } from 'vitest';
import { laneUnboundAck } from './lanes.js';

describe('laneUnboundAck (ADR 680)', () => {
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
  });

  it('says nobody is notified, and what to do with a finding instead', () => {
    // alfie's decline on the landed #3000 (2026-10-19): the first draft ended "so its owner sees
    // that you spoke", which tells the reviewer their words reached the owner. They did not, and
    // the lane's own Consequences say a row on a closed lane is a place a reviewer may not look. An
    // ack that implies a notification the daemon never makes is the same silence in a new coat.
    const ack = laneUnboundAck({ lane: 'L1', ask: 'A-old', verdict: 'decline', state: 'done' });
    expect(ack.guidance).toContain("It is recorded in the lane's history");
    expect(ack.guidance).toContain('nobody is notified');
    expect(ack.guidance).toContain("send it to the lane's owner or open a lane for it");
    // The old overclaim is gone: nothing here says the owner has been told.
    expect(ack.guidance).not.toContain('sees that you spoke');
  });

  it('names a `wait` as a wait, and a lane sent back as active', () => {
    const ack = laneUnboundAck({ lane: 'L2', ask: 'A-1', verdict: 'wait', state: 'active' });
    expect(ack.guidance).toContain('your wait');
    expect(ack.guidance).toContain('the lane is active');
  });
});
