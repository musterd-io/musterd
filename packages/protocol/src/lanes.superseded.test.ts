import { describe, expect, it } from 'vitest';
import { laneSupersededAck } from './lanes.js';

describe('laneSupersededAck (ADR 545)', () => {
  it('says the reply moved nothing and names the ask that binds now', () => {
    const ack = laneSupersededAck({
      lane: 'L1',
      ask: 'A-old',
      current: { ask: 'A-new', reviewer: 'hal' },
    });
    expect(ack).toMatchObject({ lane: 'L1', ask: 'A-old', current: { ask: 'A-new', reviewer: 'hal' } });
    expect(ack.guidance).toContain('Lane L1');
    expect(ack.guidance).toContain('moved nothing');
    expect(ack.guidance).toContain('hal (ask A-new)');
    expect(ack.guidance).toContain('reply on that id');
  });

  it('says no ask is open when nothing replaced it', () => {
    const ack = laneSupersededAck({ lane: 'L1', ask: 'A-old', current: null });
    expect(ack.guidance).toContain('moved nothing');
    expect(ack.guidance).toContain('No acceptance ask is open');
  });
});
