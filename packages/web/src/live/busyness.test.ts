import type { Envelope, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { busyness, lastActLabel } from './busyness';

const MIN = 60_000;
const env = (ts: number, over: Partial<Envelope> = {}): Envelope =>
  ({
    id: `e${ts}`,
    team: 'revive',
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    ts,
    meta: null,
    ...over,
  }) as Envelope;
const m = (name: string, over: Partial<MemberSummary> = {}): MemberSummary =>
  ({
    id: `m_${name}`,
    name,
    kind: 'agent',
    presence: 'online',
    posture: 'working',
    presences: [],
    capabilities: {},
    ...over,
  }) as unknown as MemberSummary;

describe('busyness', () => {
  it('counts who is working, between tasks, away, and how many humans are present', () => {
    const roster = [
      m('a'),
      m('b'),
      m('c', { posture: 'active' }),
      m('d', { posture: 'away', presence: 'away' }),
      m('nick', { kind: 'human', posture: 'active' }),
      m('z', { presence: 'offline', posture: 'offline' }),
    ];
    const b = busyness([], roster, 0);
    expect(b.counts).toEqual({ working: 2, between: 2, away: 1, humans: 1, present: 5 });
  });

  it('knows how long since the last act, and says so when nothing has happened', () => {
    expect(busyness([env(1_000)], [], 1_000 + 3_000).lastActAgeMs).toBe(3_000);
    expect(busyness([], [], 5).lastActAgeMs).toBeNull();
  });

  it('buckets acts per hour over the loaded span and names the true span under an hour (Review Focus 2)', () => {
    const now = 100 * MIN;
    const b = busyness([env(now - 40 * MIN), env(now - 30 * MIN), env(now - 1 * MIN)], [], now);
    expect(b.spanLabel).toBe('last 40 min');
    expect(b.rateLabel).toBe('3 acts');
    expect(b.buckets.length).toBeGreaterThan(0);
    expect(b.buckets.reduce((s, n) => s + n, 0)).toBe(3);
  });

  it('over an hour loaded, the rate is per hour and the span says how many hours', () => {
    const now = 10 * 60 * MIN;
    const acts = Array.from({ length: 60 }, (_, i) => env(now - i * 3 * MIN)); // 3h, 20/hr
    const b = busyness(acts, [], now);
    expect(b.rateLabel).toBe('20/hr');
    expect(b.spanLabel).toBe('last 3h');
    expect(b.buckets.length).toBe(12); // 15-minute buckets over 3h
  });
});

describe('lastActLabel', () => {
  it.each([
    [null, 'no acts yet'],
    [900, 'last act just now'],
    [3_000, 'last act 3s ago'],
    [4 * MIN, 'last act 4m ago'],
    [2 * 60 * MIN, 'last act 2h ago'],
  ])('%s → %s', (age, out) => expect(lastActLabel(age)).toBe(out));
});
