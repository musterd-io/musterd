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
      board(
        lane('a'),
        lane('b', { state: 'awaiting_acceptance' }),
        lane('c', { state: 'blocked' }),
      ),
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
    const { cards } = teamCards([m('a')], board(lane('a', { goal_id: 'launch', claimed_at: 5 })), [
      { id: 'launch', title: 'Launch' },
    ]);
    expect(cards[0]).toMatchObject({ goal: 'Launch', since: 5 });
  });

  it('names the goal by its NAME, not its whole story (slop tell 8)', () => {
    // Goal titles on a real team read "Name — what it promises"; the card repeated the whole
    // sentence under every member on that goal (three lines each on /live, 2026-10-01).
    const { cards } = teamCards([m('a')], board(lane('a', { goal_id: 'demo' })), [
      { id: 'demo', title: 'Demo — an audience joins a live musterd team from their phones' },
    ]);
    expect(cards[0]?.goal).toBe('Demo');
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

describe('teamCards — asking a human (ADR 464 §4)', () => {
  const askView = (from: string, to: string | null, state = 'open', ts = 5) =>
    ({
      env: {
        id: `ask_${from}_${ts}`,
        from,
        to: to ? { kind: 'member', name: to } : { kind: 'team' },
        ts,
        act: 'ask',
        body: '',
      },
      species: 'approve',
      tier: 'standard',
      to,
      deadline: ts + 1,
      state,
    }) as unknown as import('./asks').AskView;

  it('an open ask to a human says "asking nick" and sorts after blocked, before between', () => {
    const roster = [
      m('nick', { kind: 'human', posture: 'active' }),
      m('a'),
      m('b', { posture: 'active' }),
      m('c'),
    ];
    const { cards } = teamCards(
      roster,
      board(lane('a'), lane('c', { state: 'blocked' })),
      [],
      [askView('a', 'nick')],
    );
    expect(cards.map((c) => [c.name, c.state])).toEqual([
      ['c', 'blocked'],
      ['a', 'asking'],
      ['b', 'between'],
      ['nick', 'between'],
    ]);
    expect(cards[1]?.stateLabel).toBe('asking nick');
    expect(cards[1]?.title).toBe('Fix the thing'); // the lane is still the work
  });

  it('an agent-routed review ask is not "asking" (Review Focus 2), and a lapsed one is not either', () => {
    const roster = [m('stanley'), m('a')];
    expect(
      teamCards(roster, board(lane('a')), [], [askView('a', 'stanley')]).cards.find(
        (c) => c.name === 'a',
      )?.state,
    ).toBe('working');
    expect(
      teamCards(roster, board(lane('a')), [], [askView('a', null, 'lapsed')]).cards.find(
        (c) => c.name === 'a',
      )?.state,
    ).toBe('working');
  });

  it('a team-addressed open ask reads "asking the team"', () => {
    const { cards } = teamCards([m('a')], null, [], [askView('a', null)]);
    expect(cards[0]).toMatchObject({ state: 'asking', stateLabel: 'asking the team' });
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
