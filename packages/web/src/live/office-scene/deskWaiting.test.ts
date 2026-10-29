import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  deskWaitingFor,
  deskWaitingKey,
  deskWaitingLine,
  HANDOFF_STALE_MS,
  openHandoffs,
} from './deskWaiting';

const NOW = 1_800_000_000_000;

function env(id: string, from: string, act: string, to: string | null, extra: Partial<Envelope> = {}): Envelope {
  return {
    id,
    from,
    act,
    to: to === null ? { kind: 'team' } : { kind: 'member', name: to },
    ts: NOW - 60_000,
    body: '',
    ...extra,
  } as Envelope;
}

describe('openHandoffs', () => {
  it('puts an unanswered handoff on its recipient', () => {
    expect(openHandoffs([env('h1', 'ann', 'handoff', 'bo')], NOW)).toEqual(new Map([['bo', 'ann']]));
  });

  it('clears when the recipient accepts, declines or resolves it', () => {
    for (const act of ['accept', 'decline', 'resolve'])
      expect(
        openHandoffs(
          [
            env('h1', 'ann', 'handoff', 'bo'),
            env('a1', 'bo', act, 'ann', { ts: NOW - 1_000, meta: { in_reply_to: 'h1' } }),
          ],
          NOW,
        ).size,
      ).toBe(0);
  });

  it('is not settled by someone other than the recipient', () => {
    const open = openHandoffs(
      [
        env('h1', 'ann', 'handoff', 'bo'),
        env('a1', 'cy', 'accept', 'ann', { ts: NOW - 1_000, meta: { in_reply_to: 'h1' } }),
      ],
      NOW,
    );
    expect(open.get('bo')).toBe('ann');
  });

  it('ignores a team handoff, a handoff to oneself, and one older than a day', () => {
    expect(
      openHandoffs(
        [
          env('h1', 'ann', 'handoff', null),
          env('h2', 'ann', 'handoff', 'ann'),
          env('h3', 'ann', 'handoff', 'bo', { ts: NOW - HANDOFF_STALE_MS - 1 }),
        ],
        NOW,
      ).size,
    ).toBe(0);
  });

  it('names the newest sender when two wait on one desk', () => {
    const open = openHandoffs(
      [env('h2', 'cy', 'handoff', 'bo', { ts: NOW - 500 }), env('h1', 'ann', 'handoff', 'bo', { ts: NOW - 900 })],
      NOW,
    );
    expect(open.get('bo')).toBe('cy');
  });
});

describe('deskWaitingFor', () => {
  const handoffs = new Map([['bo', 'ann']]);
  const reviews = new Map([
    ['bo', 2],
    ['cy', 1],
  ]);

  it('one prop per desk: blocked, then handoff, then review', () => {
    expect(deskWaitingFor('bo', true, handoffs, reviews)).toEqual({ kind: 'blocked' });
    expect(deskWaitingFor('bo', false, handoffs, reviews)).toEqual({ kind: 'handoff', from: 'ann' });
    expect(deskWaitingFor('cy', false, handoffs, reviews)).toEqual({ kind: 'review', count: 1 });
    expect(deskWaitingFor('dee', false, handoffs, reviews)).toBeNull();
  });

  it('says it in words, and keys the desk sprite only on what changes the picture', () => {
    expect(deskWaitingLine({ kind: 'handoff', from: 'ann' })).toBe('handoff from ann');
    expect(deskWaitingLine({ kind: 'review', count: 1 })).toBe('1 to review');
    expect(deskWaitingLine({ kind: 'review', count: 3 })).toBe('3 to review');
    expect(deskWaitingKey(null)).toBe('');
    expect(deskWaitingKey({ kind: 'handoff', from: 'ann' })).toBe(deskWaitingKey({ kind: 'handoff', from: 'cy' }));
    expect(deskWaitingKey({ kind: 'review', count: 2 })).not.toBe(deskWaitingKey({ kind: 'review', count: 1 }));
  });
});
