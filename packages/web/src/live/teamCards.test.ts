import type { Lane, LaneBoard, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { elapsed, teamCards } from './teamCards';

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
const lane = (owner: string, over: Partial<Lane> = {}): Lane =>
  ({
    id: `l_${owner}_${over.title ?? 'x'}`,
    title: 'Fix the thing',
    owner_seat: owner,
    state: 'claimed',
    claimed_at: 1_000,
    updated_at: 1_000,
    goal_id: null,
    ...over,
  }) as Lane;
const board = (...lanes: Lane[]) => ({ lanes }) as unknown as LaneBoard;

describe('teamCards', () => {
  it('orders working → review → blocked → between → away, humans last within a group', () => {
    const roster = [
      m('zed', { posture: 'away', presence: 'away' }),
      m('nick', { kind: 'human', posture: 'working' }),
      m('amy', { posture: 'active' }),
      m('bob'),
      m('cat'),
      m('dan'),
    ];
    const b = board(
      lane('bob'),
      lane('nick'),
      lane('cat', { state: 'awaiting_acceptance' }),
      lane('dan', { state: 'blocked' }),
    );
    const { cards } = teamCards(roster, b, []);
    expect(cards.map((c) => c.name)).toEqual(['bob', 'nick', 'cat', 'dan', 'amy', 'zed']);
    expect(cards.map((c) => c.state)).toEqual([
      'working',
      'working',
      'review',
      'blocked',
      'between',
      'away',
    ]);
  });

  it('says what each state means in plain words', () => {
    const { cards } = teamCards(
      [
        m('a'),
        m('b'),
        m('c'),
        m('d', { posture: 'active' }),
        m('e', { posture: 'away', presence: 'away' }),
      ],
      board(lane('a'), lane('b', { state: 'awaiting_acceptance' }), lane('c', { state: 'blocked' })),
      [],
    );
    expect(cards.map((c) => c.stateLabel)).toEqual([
      'working on',
      'waiting for review',
      'blocked on',
      'between tasks',
      'away',
    ]);
  });

  it('shows the freshest in-flight lane and counts the rest (Review Focus 1)', () => {
    const { cards } = teamCards(
      [m('a')],
      board(lane('a', { title: 'old', claimed_at: 1 }), lane('a', { title: 'new', claimed_at: 9 })),
      [],
    );
    expect(cards[0]).toMatchObject({ title: 'new', source: 'lane', moreLanes: 1 });
  });

  it('names the goal and keeps claimed_at for elapsed', () => {
    const { cards } = teamCards(
      [m('a')],
      board(lane('a', { goal_id: 'launch', claimed_at: 5 })),
      [{ id: 'launch', title: 'Launch' }],
    );
    expect(cards[0]).toMatchObject({ goal: 'Launch', since: 5 });
  });

  it('with no board yet, still renders every present member (Review Focus 5)', () => {
    const { cards } = teamCards(
      [m('a', { state: 'reading the spec', posture: 'active' })],
      null,
      [],
    );
    expect(cards[0]).toMatchObject({
      title: 'reading the spec',
      source: 'status',
      state: 'between',
    });
  });

  it('folds offline seats into a count', () => {
    const out = teamCards([m('a'), m('b', { presence: 'offline', posture: 'offline' })], null, []);
    expect(out.cards.map((c) => c.name)).toEqual(['a']);
    expect(out.offline).toBe(1);
  });
});

describe('elapsed', () => {
  const MIN = 60_000;
  it.each([
    [null, null],
    [0, '<1m'],
    [42 * MIN, '42m'],
    [3 * 60 * MIN, '3h'],
    [2 * 24 * 60 * MIN, '2d'],
  ])('%s → %s', (dt, out) => {
    expect(elapsed(dt === null ? null : 1_000, 1_000 + (dt ?? 0))).toBe(out);
  });
});
