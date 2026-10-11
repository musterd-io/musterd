import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { advance, initialState, type TourState } from './machine.js';

const env = (p: Partial<Envelope> & { meta?: Record<string, unknown> }): Envelope =>
  ({
    v: 1,
    id: p.id ?? 'A1',
    team: 't',
    from: p.from ?? 'ada',
    to: p.to ?? { kind: 'team' },
    act: p.act ?? 'message',
    body: p.body ?? '',
    thread: null,
    ts: 1,
    meta: p.meta ?? null,
  }) as unknown as Envelope;

const at = (step: TourState['step'], extra: Partial<TourState> = {}): TourState => ({
  ...initialState('nick', 'ada'),
  step,
  laneId: 'L1',
  requestId: 'R1',
  ...extra,
});

describe('tour machine', () => {
  it('walks the happy path', () => {
    let s = initialState('nick', 'ada');
    s = advance(s, { type: 'continue' });
    expect(s.step).toBe('team');
    s = advance(s, { type: 'continue' });
    expect(s.step).toBe('give_work');
    s = advance(s, { type: 'lane_opened', laneId: 'L1', requestId: 'R1' });
    expect(s.step).toBe('claims');
    s = advance(s, { type: 'act', env: env({ meta: { lane_claim: { lane: 'L1', title: 't' } } }) });
    expect(s.step).toBe('hands_back');
    s = advance(s, {
      type: 'act',
      env: env({
        id: 'Q1',
        act: 'ask',
        to: { kind: 'member', name: 'nick' },
        meta: { lane_review: { lane: 'L1' } },
      }),
    });
    expect(s).toMatchObject({ step: 'judge', askId: 'Q1' });
    s = advance(s, { type: 'verdict', accept: true });
    expect(s).toMatchObject({ step: 'record', outcome: 'accepted' });
  });
  it('ignores other lanes', () => {
    const s = at('claims');
    expect(advance(s, { type: 'act', env: env({ meta: { lane_claim: { lane: 'L2' } } }) })).toBe(s);
  });
  it('ignores a claim by someone else', () => {
    const s = at('claims');
    expect(
      advance(s, { type: 'act', env: env({ from: 'bob', meta: { lane_claim: { lane: 'L1' } } }) }),
    ).toBe(s);
  });
  it('records a decline that replies to the request', () => {
    const s = advance(at('claims'), {
      type: 'act',
      env: env({ act: 'decline', body: 'no README here', meta: { in_reply_to: 'R1' } }),
    });
    expect(s).toMatchObject({
      step: 'claims',
      outcome: 'declined',
      declineReason: 'no README here',
    });
    expect(advance(s, { type: 'skip_to_record' }).step).toBe('record');
  });
  it('self-close while waiting', () => {
    for (const step of ['hands_back', 'judge'] as const) {
      const s = advance(at(step), {
        type: 'act',
        env: env({ meta: { lane_resolve: { lane: 'L1', state: 'done' } } }),
      });
      expect(s).toMatchObject({ step: 'record', outcome: 'self_closed' });
    }
  });
  it('sending it back returns to hands_back', () => {
    const s = advance(at('judge', { askId: 'Q1' }), { type: 'verdict', accept: false });
    expect(s).toMatchObject({ step: 'hands_back', sentBack: 1 });
    expect(s.askId).toBeUndefined();
  });
  it('continue does nothing on an event step', () => {
    const s = at('claims');
    expect(advance(s, { type: 'continue' })).toBe(s);
  });
});
