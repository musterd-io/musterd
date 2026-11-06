import type { Lane, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { appForYou, appMembers, liveAsks, type AskLike, type CloserLike } from './appTeam.js';

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

describe('liveAsks: an ask is open on the phone exactly when /live shows it loud', () => {
  const ask = (id: string, over: Partial<AskLike> = {}): AskLike => ({
    id,
    ts: NOW - MIN,
    thread: null,
    meta: { species: 'approve', tier: 'blocking' },
    ...over,
  });
  const close = (over: Partial<CloserLike> & { act: string }): CloserLike => ({
    ts: NOW,
    thread: null,
    meta: null,
    ...over,
  });
  const ids = (asks: AskLike[], closers: CloserLike[] = []) =>
    liveAsks(asks, closers, NOW).map((a) => a.id);

  it('keeps an open ask inside its tier deadline', () => {
    expect(ids([ask('a', { meta: { species: 'approve', tier: 'standard' } })])).toEqual(['a']);
  });

  it('lapses a standard or advisory ask past its deadline: the work went on without you', () => {
    const old = NOW - 6 * MIN;
    expect(
      ids([
        ask('std', { ts: old, meta: { species: 'approve', tier: 'standard' } }),
        ask('adv', { ts: old, meta: { species: 'consult', tier: 'advisory' } }),
      ]),
    ).toEqual([]);
  });

  it('keeps a blocking ask past its deadline: it is held, the loudest thing there is', () => {
    expect(ids([ask('blk', { ts: NOW - 4 * 24 * 60 * MIN })])).toEqual(['blk']);
  });

  it('reads a review ask’s own window, not the bare tier', () => {
    const meta = { species: 'approve', tier: 'standard', lane_review: { wait_ms: 20 * MIN } };
    expect(ids([ask('rev', { ts: NOW - 10 * MIN, meta })])).toEqual(['rev']);
    expect(ids([ask('rev', { ts: NOW - 30 * MIN, meta })])).toEqual([]);
  });

  it('closes on a later accept, decline, or a wait that defers it, by reply or ask_ref', () => {
    expect(ids([ask('a')], [close({ act: 'accept', meta: { in_reply_to: 'a' } })])).toEqual([]);
    expect(ids([ask('b')], [close({ act: 'decline', meta: { in_reply_to: 'b' } })])).toEqual([]);
    expect(ids([ask('c')], [close({ act: 'wait', meta: { ask_ref: 'c' } })])).toEqual([]);
  });

  it('closes on a resolve on its thread — how a publisher withdraws a superseded deploy ask', () => {
    expect(ids([ask('d')], [close({ act: 'resolve', thread: 'd' })])).toEqual([]);
    expect(ids([ask('e', { thread: 't1' })], [close({ act: 'resolve', thread: 't1' })])).toEqual(
      [],
    );
  });

  it('closes on an asker’s risk_accepted or stranded outcome, but a held outcome stays loud', () => {
    const outcome = (o: string) =>
      close({ act: 'status_update', meta: { ask_ref: 'f', ask_outcome: o } });
    expect(ids([ask('f')], [outcome('risk_accepted')])).toEqual([]);
    expect(ids([ask('f')], [outcome('stranded')])).toEqual([]);
    expect(ids([ask('f')], [outcome('held')])).toEqual(['f']);
  });

  it('ignores an act that came before the ask, and an ask that is not well formed', () => {
    expect(ids([ask('g')], [close({ act: 'resolve', thread: 'g', ts: NOW - 2 * MIN })])).toEqual([
      'g',
    ]);
    expect(ids([ask('h', { meta: { tier: 'blocking' } })])).toEqual([]);
  });
});
