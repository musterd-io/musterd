import type { Lane, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { appForYou, appMembers } from './appTeam.js';

/**
 * ADR 814: the daemon folds the team for the phone by the rule /live's team column uses
 * (`packages/web/src/live/teamCards.ts`), so a member reads the same on both.
 */

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const summary = (over: Partial<MemberSummary> & { name: string }): MemberSummary =>
  ({
    kind: 'agent',
    presence: 'online',
    posture: 'working',
    presences: [{ status: 'online', surface: 'claude-code', model: 'claude-opus-5-5' }],
    state: null,
    ...over,
  }) as unknown as MemberSummary;

const lane = (over: Partial<Lane> & { id: string; owner_seat: string }): Lane =>
  ({
    title: `lane ${over.id}`,
    state: 'active',
    goal_id: null,
    claimed_at: NOW - 10 * MIN,
    updated_at: NOW - 10 * MIN,
    ...over,
  }) as unknown as Lane;

const fold = (
  roster: MemberSummary[],
  opts: {
    lanes?: Lane[];
    goals?: { id: string; title: string }[];
    asking?: Map<string, { to: string | null }>;
    waiting?: Map<string, { to: string | null; since: number }>;
  } = {},
) =>
  appMembers({
    roster,
    lanes: opts.lanes ?? [],
    goals: opts.goals ?? [],
    asking: opts.asking ?? new Map(),
    waiting: opts.waiting ?? new Map(),
    seats: new Map(),
    now: NOW,
  });

describe('appMembers: /live’s card state, label and order', () => {
  it('reads a lane awaiting acceptance as waiting for review', () => {
    const [m] = fold([summary({ name: 'big-body' })], {
      lanes: [lane({ id: 'L1', owner_seat: 'big-body', state: 'awaiting_acceptance' })],
    });
    expect(m).toMatchObject({ state: 'review', label: 'waiting for review', title: 'lane L1' });
  });

  it('reads a blocked lane as blocked on', () => {
    const [m] = fold([summary({ name: 'wallow' })], {
      lanes: [lane({ id: 'L2', owner_seat: 'wallow', state: 'blocked' })],
    });
    expect(m).toMatchObject({ state: 'blocked', label: 'blocked on' });
  });

  it('reads an open question to a person as waiting on them, with how long', () => {
    const [m] = fold([summary({ name: 'izzo' })], {
      lanes: [lane({ id: 'L3', owner_seat: 'izzo' })],
      waiting: new Map([['izzo', { to: 'nick', since: NOW - 42 * MIN }]]),
    });
    expect(m).toMatchObject({ state: 'asking', label: 'waiting on nick · 42m', title: 'lane L3' });
  });

  it('reads an open ask to a person as asking them, ahead of the question line', () => {
    const [m] = fold([summary({ name: 'miley' })], {
      asking: new Map([['miley', { to: 'nick' }]]),
      waiting: new Map([['miley', { to: 'nick', since: NOW - 5 * MIN }]]),
    });
    expect(m).toMatchObject({ state: 'asking', label: 'asking nick' });
  });

  it('reads a person with no lane and a status line as between tasks, quoting the status', () => {
    const [m] = fold([summary({ name: 'nick', kind: 'human', state: 'on stream till 6' })]);
    expect(m).toMatchObject({
      state: 'between',
      label: 'between tasks',
      title: 'on stream till 6',
      source: 'status',
      model: 'human',
    });
  });

  it('reads an offline member as away, after every present one', () => {
    const names = fold([
      summary({ name: 'ryder', presence: 'offline', posture: 'offline' }),
      summary({ name: 'cider' }),
    ]).map((m) => [m.name, m.state]);
    expect(names).toEqual([
      ['cider', 'between'],
      ['ryder', 'away'],
    ]);
  });

  it('reads a member whose posture is away as away even while present', () => {
    const [m] = fold([summary({ name: 'dolly', kind: 'human', posture: 'away' })]);
    expect(m?.state).toBe('away');
  });

  it('sorts working, review, blocked, asking, between; people last within a state; newest lane first', () => {
    const order = fold(
      [
        summary({ name: 'stanley' }),
        summary({ name: 'nick', kind: 'human' }),
        summary({ name: 'big-body' }),
        summary({ name: 'izzo' }),
        summary({ name: 'fifty', kind: 'human' }),
        summary({ name: 'lazara' }),
        summary({ name: 'cider' }),
      ],
      {
        lanes: [
          lane({ id: 'a', owner_seat: 'lazara', claimed_at: NOW - 30 * MIN }),
          lane({ id: 'b', owner_seat: 'cider', claimed_at: NOW - 5 * MIN }),
          lane({ id: 'c', owner_seat: 'fifty', claimed_at: NOW - 1 * MIN }),
          lane({ id: 'd', owner_seat: 'big-body', state: 'awaiting_acceptance' }),
        ],
        waiting: new Map([['izzo', { to: 'nick', since: NOW - MIN }]]),
      },
    ).map((m) => m.name);
    expect(order).toEqual(['cider', 'lazara', 'fifty', 'big-body', 'izzo', 'stanley', 'nick']);
  });

  it('names the goal before its dash, counts the other lanes, and dates from the claim', () => {
    const [m] = fold([summary({ name: 'lazara' })], {
      lanes: [
        lane({ id: 'new', owner_seat: 'lazara', goal_id: 'g1', claimed_at: NOW - 3 * MIN }),
        lane({ id: 'old', owner_seat: 'lazara', claimed_at: NOW - 90 * MIN }),
      ],
      goals: [{ id: 'g1', title: 'coordination-cost — agents hear when a held file frees up' }],
    });
    expect(m).toMatchObject({
      title: 'lane new',
      goal: 'coordination-cost',
      since: NOW - 3 * MIN,
      more_lanes: 1,
    });
  });

  it('labels the model as the team column does, and says so when there is none', () => {
    const rows = fold([
      summary({ name: 'a' }),
      summary({
        name: 'b',
        presences: [{ status: 'online', model: null }] as unknown as MemberSummary['presences'],
      }),
    ]);
    expect(rows.map((m) => m.model)).toEqual(['opus 5.5', 'model unknown']);
  });
});

describe('appForYou: what waits on the binding’s person', () => {
  it('lists oldest first, one line each, cut at 200 characters', () => {
    const items = appForYou([
      { id: 'b', from: 'fifty', kind: 'question', body: 'Rotate now?', ts: NOW - MIN },
      {
        id: 'a',
        from: 'miley',
        kind: 'approve',
        body: `Merge\n#3961?${'x'.repeat(300)}`,
        ts: NOW - 9 * MIN,
      },
    ]);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(items[0]!.summary.length).toBeLessThanOrEqual(200);
    expect(items[0]!.summary.startsWith('Merge #3961?')).toBe(true);
  });

  it('keeps at most 32', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `q${i}`,
      from: 'izzo',
      kind: 'question' as const,
      body: 'Which?',
      ts: i,
    }));
    expect(appForYou(many)).toHaveLength(32);
  });
});
