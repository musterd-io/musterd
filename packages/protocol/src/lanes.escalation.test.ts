import { describe, expect, it } from 'vitest';
import { laneEscalationAck } from './lanes.js';

/** ADR 539: the ack for an accept that was the PEER stage on a risky lane — one text, every surface. */
describe('laneEscalationAck', () => {
  it('names who holds the verdict when a human was asked', () => {
    const ack = laneEscalationAck({ lane: 'L1', human: 'nick' });
    expect(ack).toMatchObject({ lane: 'L1', human: 'nick' });
    expect(ack.guidance).toContain('Lane L1');
    expect(ack.guidance).toContain('PEER confirmation');
    expect(ack.guidance).toContain('did not close the lane');
    expect(ack.guidance).toContain('nick has been asked');
  });

  it('says nobody was live, that the lane shows as pending, and that the daemon will ask', () => {
    const ack = laneEscalationAck({ lane: 'L1', human: null });
    expect(ack.human).toBeNull();
    expect(ack.guidance).toContain('No human is live');
    expect(ack.guidance).toContain('peer-confirmed, waiting for a human');
    expect(ack.guidance).toContain('first human who comes live');
    expect(ack.guidance).toContain('Nothing more is owed by you');
  });
});
