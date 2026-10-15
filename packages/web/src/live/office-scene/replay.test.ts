import type { Envelope, Recipient } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { REPLAY_MAX, replayAge, replayEvents } from './replay';

const NOW = 100 * 60_000;
let n = 0;
const env = (over: Partial<Envelope>): Envelope =>
  ({
    v: 1,
    id: `e${++n}`,
    team: 'revive',
    from: 'izzo',
    to: { kind: 'team' } as Recipient,
    act: 'message',
    body: '[lane] x',
    ts: NOW - 60_000,
    ...over,
  }) as Envelope;
const claim = (over: Partial<Envelope> = {}) =>
  env({ meta: { lane_claim: { lane: '01L', title: 'Rotate keys' } }, ...over });

describe('replayEvents — the walks of the last ten minutes, oldest first', () => {
  it('keeps claim / pin / handoff from backfill inside the window, in time order', () => {
    const evs = replayEvents(
      [
        claim({ ts: NOW - 30_000 }),
        env({ meta: { lane_resolve: { lane: '01L', title: 'Rotate keys', state: 'done' } }, ts: NOW - 20_000 }),
        env({ act: 'handoff', to: { kind: 'member', name: 'ada' } as Recipient, meta: { lane_handoff: { lane: '01L' } }, ts: NOW - 10_000 }),
        claim({ ts: NOW - 90_000 }),
        env({ act: 'ask', to: { kind: 'member', name: 'ada' } as Recipient, meta: { lane_review: { lane: '01L' } }, ts: NOW - 5_000 }),
      ],
      new Set(),
      NOW,
    );
    expect(evs.map((e) => e.kind)).toEqual(['walk-claim', 'walk-claim', 'walk-pin', 'walk-handoff', 'walk-deliver']);
  });

  it('leaves out live acts (they already played), acts older than the window, and non-walks', () => {
    const live = claim({ id: 'live', ts: NOW - 1_000 });
    const evs = replayEvents(
      [
        live,
        claim({ ts: NOW - 11 * 60_000 }),
        env({ act: 'status_update', body: 'working', ts: NOW - 5_000 }),
        env({ meta: { lane_open: { lane: '01L', title: 't' } }, ts: NOW - 5_000 }),
        claim({ ts: NOW - 5_000 }),
      ],
      new Set(['live']),
      NOW,
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]!.kind).toBe('walk-claim');
  });

  it('caps at the newest REPLAY_MAX, still oldest-first', () => {
    const many = Array.from({ length: REPLAY_MAX + 4 }, (_, i) => claim({ ts: NOW - (REPLAY_MAX + 4 - i) * 1_000 }));
    const evs = replayEvents(many, new Set(), NOW);
    expect(evs).toHaveLength(REPLAY_MAX);
    // the four oldest fell off: the first survivor is the 5th-oldest
    expect((evs[0] as { lane: string }).lane).toBe('01L');
    expect(replayEvents([], new Set(), NOW)).toEqual([]);
  });
});

describe('the age a replayed walk wears (lane 01M50TZA8X)', () => {
  it('stamps each replayed walk with the time its act was sent', () => {
    const evs = replayEvents([claim({ ts: NOW - 4 * 60_000 })], new Set(), NOW);
    expect(evs.map((e) => e.at)).toEqual([NOW - 4 * 60_000]);
  });

  it('says "just now" under a minute, then whole minutes', () => {
    expect(replayAge(0)).toBe('just now');
    expect(replayAge(59_999)).toBe('just now');
    expect(replayAge(60_000)).toBe('1m ago');
    expect(replayAge(4 * 60_000 + 30_000)).toBe('4m ago');
    expect(replayAge(9 * 60_000 + 59_000)).toBe('9m ago');
  });

  it('never shows a negative age when the clocks disagree', () => {
    expect(replayAge(-5_000)).toBe('just now');
  });
});
