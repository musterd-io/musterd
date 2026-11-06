import { makeEnvelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { APP_NUDGE_COALESCE_MS, isNudgeMoment, NudgeGate } from './appNudge.js';

/** ADR 819 decisions 2–3: a landing or a finished goal nudges the phone, at most once per 5 s. */

const env = (meta?: Record<string, unknown>, act: 'message' | 'accept' = 'message') =>
  makeEnvelope({
    id: 'm1',
    team: 't',
    from: 'cider',
    to: { kind: 'team' },
    act,
    body: 'x',
    ts: 1,
    ...(meta ? { meta } : {}),
  });

describe('isNudgeMoment: what the phone should see within seconds', () => {
  it('nudges on a lane resolved done, not on one abandoned', () => {
    expect(isNudgeMoment(env({ lane_resolve: { lane: 'L', title: 'T', state: 'done' } }))).toBe(
      true,
    );
    expect(
      isNudgeMoment(env({ lane_resolve: { lane: 'L', title: 'T', state: 'abandoned' } })),
    ).toBe(false);
  });

  it('nudges on an acceptor’s accept that closed a lane (ADR 202)', () => {
    expect(isNudgeMoment(env({ in_reply_to: 'a1' }, 'accept'), { lane: 'L', state: 'done' })).toBe(
      true,
    );
    expect(
      isNudgeMoment(env({ in_reply_to: 'a1' }, 'accept'), { lane: 'L', state: 'active' }),
    ).toBe(false);
  });

  it('nudges on a goal outcome, not on a plain message', () => {
    expect(isNudgeMoment(env({ goal_outcome: { goal_id: 'g', outcome: 'o' } }))).toBe(true);
    expect(isNudgeMoment(env())).toBe(false);
  });
});

describe('NudgeGate: a burst of merges is one push per phone', () => {
  it('sends the first in a window and coalesces the rest', () => {
    const gate = new NudgeGate(APP_NUDGE_COALESCE_MS);
    const sent = [0, 1_000, 2_000, 3_000, 4_000].map((t) => gate.shouldSend('b1', t));
    expect(sent).toEqual([true, false, false, false, false]);
    expect(gate.shouldSend('b1', 6_000)).toBe(true);
  });

  it('keeps each phone’s window apart', () => {
    const gate = new NudgeGate(APP_NUDGE_COALESCE_MS);
    expect(gate.shouldSend('b1', 0)).toBe(true);
    expect(gate.shouldSend('b2', 100)).toBe(true);
    expect(gate.shouldSend('b1', 200)).toBe(false);
  });

  it('waits five seconds', () => {
    expect(APP_NUDGE_COALESCE_MS).toBe(5_000);
  });
});
