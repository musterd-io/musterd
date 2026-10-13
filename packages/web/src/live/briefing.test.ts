import {
  GOAL_STALE_DAYS as PROTOCOL_STALE_DAYS,
  LANE_TERMINAL_STATES as PROTOCOL_TERMINAL,
  type LaneBoard,
  type MemberSummary,
} from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { AskView } from './asks';
import {
  briefing,
  briefingSince,
  GOAL_STALE_DAYS,
  LANE_TERMINAL_STATES,
  needsHeading,
  SHIPPED_WINDOW_MS,
  waitingFor,
} from './briefing';

const NOW = 1_800_000_000_000;
const lane = (id: string, state: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  state,
  owner_seat: 'ann',
  goal_id: null,
  depends_on: [],
  claimed_at: NOW - 60_000,
  updated_at: NOW - 60_000,
  resolved_at: null,
  ...over,
});
const board = (...lanes: unknown[]) => ({ lanes, warnings: [] }) as unknown as LaneBoard;
const ask = (
  id: string,
  state: string,
  species = 'consult',
  age = 5_000,
  to: string | null = 'nick',
): AskView =>
  ({
    env: { id, from: 'ann', ts: NOW - age, body: 'May I?\nmore' },
    species,
    tier: 'standard',
    to,
    deadline: NOW + 1,
    state,
  }) as unknown as AskView;
const member = (name: string, kind: string, presence = 'online') =>
  ({ name, kind, presence }) as unknown as MemberSummary;
const ROSTER = [member('ann', 'agent'), member('nick', 'human'), member('dreamy', 'agent')];
const run = (over: Record<string, unknown> = {}) =>
  briefing({ board: board(), goals: [], asks: [], roster: ROSTER, now: NOW, ...over });

describe('briefing', () => {
  it('buckets lanes by state', () => {
    const b = run({
      board: board(
        lane('a', 'active'),
        lane('b', 'claimed'),
        lane('c', 'blocked'),
        lane('d', 'awaiting_acceptance'),
        lane('e', 'open', { owner_seat: null }),
      ),
    });
    expect(b.inProgress.map((x) => x.id)).toEqual(['lane:a', 'lane:b']);
    expect(b.inReview.map((x) => x.id)).toEqual(['lane:d']);
    expect(b.needsHuman.map((x) => [x.kind, x.laneId])).toEqual([['blocked', 'c']]);
  });

  it('puts loud asks and approve-asks in needsHuman, longest-waiting first, and not settled ones', () => {
    const b = run({ asks: [ask('1', 'open'), ask('2', 'held', 'approve', 9_000), ask('3', 'accepted')] });
    expect(b.needsHuman.map((x) => [x.id, x.kind])).toEqual([
      ['ask:2', 'approval'],
      ['ask:1', 'ask'],
    ]);
    expect(b.needsHuman[1]!.title).toBe('May I?');
    expect(b.needsHuman[1]!.waitingOn).toBe('nick');
    expect(b.needsHuman.map((x) => x.ref)).toEqual(['2', '1']);
  });

  it('does not count an ask routed to an agent — that is a review, not a person waiting', () => {
    const b = run({
      asks: [ask('1', 'open', 'consult', 5_000, 'dreamy'), ask('2', 'open', 'consult', 5_000, null)],
    });
    expect(b.needsHuman.map((x) => x.id)).toEqual(['ask:2']);
  });

  it('counts a lane in progress only while its owner is present', () => {
    const b = run({
      board: board(lane('a', 'active'), lane('b', 'claimed', { owner_seat: 'ghosted' })),
      roster: [...ROSTER, member('ghosted', 'agent', 'offline')],
    });
    expect(b.inProgress.map((x) => x.id)).toEqual(['lane:a']);
  });

  it('includes seat requests only when the caller passes them', () => {
    const req = { id: 'r1', target: 'seat:zed', ts: NOW - 1000, status: 'pending' } as never;
    expect(run().needsHuman).toEqual([]);
    const b = run({ requests: [req] });
    expect(b.needsHuman.map((x) => [x.kind, x.title])).toEqual([['seat-request', 'wants to join as zed']]);
  });

  it('ignores a seat request that is no longer pending', () => {
    const req = { id: 'r1', target: null, ts: NOW - 1000, status: 'approved' } as never;
    expect(run({ requests: [req] }).needsHuman).toEqual([]);
  });

  it('keeps a lane shipped inside 24h and drops it outside', () => {
    const b = run({
      board: board(
        lane('in', 'done', { resolved_at: NOW - SHIPPED_WINDOW_MS + 60_000 }),
        lane('out', 'done', { resolved_at: NOW - SHIPPED_WINDOW_MS - 60_000 }),
      ),
    });
    expect(b.shipped.map((x) => x.id)).toEqual(['lane:in']);
  });

  it('survives a blocked lane with no owner, and an in-progress lane with no goal', () => {
    const b = run({ board: board(lane('x', 'blocked', { owner_seat: null })) });
    expect(b.needsHuman[0]!.owner).toBeNull();
    const w = run({ board: board(lane('y', 'active')) });
    expect(w.inProgress[0]).toMatchObject({ owner: 'ann', goal: null });
  });

  it('leaves an unowned lane out of in progress rather than crashing', () => {
    expect(run({ board: board(lane('z', 'active', { owner_seat: null })) }).inProgress).toEqual([]);
  });

  it('names the goal by its short title', () => {
    const b = run({
      board: board(lane('a', 'active', { goal_id: 'g1' })),
      goals: [{ id: 'g1', title: 'Launch — ships publicly' }],
    });
    expect(b.inProgress[0]!.goal).toBe('Launch');
  });

  it('headline counts equal list lengths', () => {
    const b = run({
      board: board(
        lane('a', 'active'),
        lane('b', 'active'),
        lane('c', 'blocked'),
        lane('d', 'done', { resolved_at: NOW - 1000 }),
      ),
      asks: [ask('1', 'open')],
    });
    expect(b.headline).toBe('2 in progress · 2 need a human · 1 shipped today');
    expect(b.inProgress).toHaveLength(2);
    expect(b.needsHuman).toHaveLength(2);
    expect(b.shipped).toHaveLength(1);
  });

  it('says "needs" for exactly one', () => {
    expect(run({ asks: [ask('1', 'open')] }).headline).toBe('1 needs a human');
  });

  it('says quiet for an empty team and for a missing board', () => {
    expect(run().headline).toBe('quiet — nothing in flight');
    expect(run({ board: null }).headline).toBe('quiet — nothing in flight');
  });

  it('puts every kind of ask under the human who has to act, headed by what they are asked for', () => {
    const b = run({
      asks: [
        ask('1', 'open', 'approve', 9_000, 'nick'),
        ask('2', 'open', 'consult', 8_000, 'nick'),
        ask('3', 'open', 'escalate', 7_000, null),
      ],
    });
    expect(b.needsGroups.map((g) => [g.human, g.heading])).toEqual([
      ['nick', 'Needs approval and clarification from nick'],
      ['the team', 'Needs an answer from the team'],
    ]);
    expect(b.needsGroups[0]!.items.map((i) => i.ref)).toEqual(['1', '2']);
  });

  it('gives a seat claim to an admin, and keeps blocked lanes out of the human groups', () => {
    const req = { id: 'r1', target: 'seat:zed', ts: NOW - 1000, status: 'pending' } as never;
    const b = run({ requests: [req], board: board(lane('c', 'blocked')) });
    expect(b.needsGroups.map((g) => g.heading)).toEqual(['Needs approval from an admin']);
    expect(b.blocked.map((x) => x.laneId)).toEqual(['c']);
    expect(b.needsHuman).toHaveLength(2); // the headline still counts both
  });

  it('says what a blocked lane waits on when it declares an open dependency', () => {
    const b = run({
      board: board(
        lane('dep', 'active', { title: 'the thing it needs', owner_seat: 'bob' }),
        lane('c', 'blocked', { depends_on: ['dep'] }),
      ),
    });
    expect(b.blocked[0]!.waitsOn).toEqual({ title: 'the thing it needs', owner: 'bob' });
    const done = run({
      board: board(lane('dep', 'done'), lane('c', 'blocked', { depends_on: ['dep'] })),
    });
    expect(done.blocked[0]!.waitsOn).toBeNull();
  });

  it('groups in progress by goal, the biggest first and the goalless last', () => {
    const b = run({
      board: board(
        lane('a', 'active', { goal_id: 'g1' }),
        lane('b', 'active', { goal_id: 'g2' }),
        lane('c', 'active', { goal_id: 'g2' }),
        lane('d', 'active'),
      ),
      goals: [
        { id: 'g1', title: 'Launch — ships' },
        { id: 'g2', title: 'Cloud — hosted' },
      ],
    });
    expect(b.byGoal.map((g) => [g.goal, g.items.length])).toEqual([
      ['Cloud', 2],
      ['Launch', 1],
      ['No goal', 1],
    ]);
  });

  it('lists what shipped since a given moment, by who shipped it, the most first', () => {
    const since = NOW - 3 * 24 * 60 * 60 * 1000;
    const b = run({
      shippedSince: since,
      board: board(
        lane('a', 'done', { owner_seat: 'ann', resolved_at: NOW - 2 * 24 * 60 * 60 * 1000 }),
        lane('b', 'done', { owner_seat: 'bob', resolved_at: NOW - 1000 }),
        lane('c', 'done', { owner_seat: 'bob', resolved_at: NOW - 2000 }),
        lane('d', 'done', { owner_seat: 'ann', resolved_at: since - 1 }),
      ),
    });
    expect(b.shippedBy.map((g) => [g.who, g.items.length])).toEqual([
      ['bob', 2],
      ['ann', 1],
    ]);
    // the headline stays "today": only the two inside 24 h
    expect(b.headline).toBe('2 shipped today');
  });
});

describe('briefingSince', () => {
  const at = (iso: string) => new Date(iso).getTime();
  const day = (ms: number) => new Date(ms).getDay();
  it('reaches back to the previous working day, and to Friday over a weekend', () => {
    // 2026-10-07 is a Wednesday, 10-12 a Monday, 10-10 a Saturday, 10-11 a Sunday.
    expect(day(briefingSince(at('2026-10-07T09:00:00')))).toBe(2); // Tue
    expect(day(briefingSince(at('2026-10-12T09:00:00')))).toBe(5); // Mon → Fri
    expect(day(briefingSince(at('2026-10-11T09:00:00')))).toBe(5); // Sun → Fri
    expect(day(briefingSince(at('2026-10-10T09:00:00')))).toBe(5); // Sat → Fri
  });

  it('starts at midnight of that day', () => {
    const d = new Date(briefingSince(at('2026-10-07T15:30:00')));
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });
});

describe('needsHeading', () => {
  it('names one want plainly, and joins several in a fixed order', () => {
    expect(needsHeading('nick', ['approval'])).toBe('Needs approval from nick');
    expect(needsHeading('nick', ['an answer', 'approval', 'clarification'])).toBe(
      'Needs approval, clarification and an answer from nick',
    );
  });
});

// Live-briefing spec, "The Now card, v2": a goal row says how far along it is ("3 of 8 done"), what
// is moving in it, and whose faces are on it.
describe('goalsInMotion', () => {
  const GOALS = [
    { id: 'g1', title: 'Launch — musterd ships publicly' },
    { id: 'g2', title: 'Postgres store' },
    { id: 'g3', title: 'Quiet goal' },
  ];

  it('counts done of total per goal, leaving abandoned lanes out of both', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'active', { goal_id: 'g1' }),
        lane('b', 'done', { goal_id: 'g1' }),
        lane('c', 'done', { goal_id: 'g1' }),
        lane('d', 'open', { goal_id: 'g1', owner_seat: null }),
        lane('e', 'abandoned', { goal_id: 'g1' }),
      ),
    });
    const g = b.goalsInMotion.find((x) => x.goalId === 'g1')!;
    expect([g.done, g.total]).toEqual([2, 4]);
    expect(g.name).toBe('Launch');
    expect(g.title).toBe('Launch — musterd ships publicly');
  });

  it('is in motion only while something in it is working, in review or blocked', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'awaiting_acceptance', { goal_id: 'g2' }),
        lane('b', 'blocked', { goal_id: 'g2', owner_seat: 'dreamy' }),
        lane('c', 'done', { goal_id: 'g3' }),
        lane('d', 'open', { goal_id: 'g3', owner_seat: null }),
      ),
    });
    expect(b.goalsInMotion.map((g) => g.goalId)).toEqual(['g2']);
    const g = b.goalsInMotion[0]!;
    expect([g.working, g.review, g.blocked]).toEqual([0, 1, 1]);
  });

  it('puts the people on its moving lanes in, newest first and once each', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'active', { goal_id: 'g1', owner_seat: 'ann', claimed_at: NOW - 9_000 }),
        lane('b', 'active', { goal_id: 'g1', owner_seat: 'nick', claimed_at: NOW - 1_000 }),
        lane('c', 'claimed', { goal_id: 'g1', owner_seat: 'ann', claimed_at: NOW - 5_000 }),
        lane('d', 'done', { goal_id: 'g1', owner_seat: 'dreamy' }),
      ),
    });
    expect(b.goalsInMotion[0]!.people).toEqual(['nick', 'ann']);
  });

  it('orders by the newest moving lane, with lanes on no goal last', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('n', 'active', { goal_id: null, claimed_at: NOW - 100 }),
        lane('a', 'active', { goal_id: 'g1', claimed_at: NOW - 9_000 }),
        lane('b', 'active', { goal_id: 'g2', claimed_at: NOW - 1_000 }),
      ),
    });
    expect(b.goalsInMotion.map((g) => g.name)).toEqual(['Postgres store', 'Launch', 'No goal']);
    expect(b.goalsInMotion[2]!.goalId).toBeNull();
  });

  it('agrees with the headline: its working counts sum to in progress', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'active', { goal_id: 'g1' }),
        lane('b', 'claimed', { goal_id: 'g2' }),
        lane('c', 'active', { goal_id: null }),
      ),
    });
    expect(b.goalsInMotion.reduce((n, g) => n + g.working, 0)).toBe(b.inProgress.length);
  });
});

describe('waitingFor', () => {
  it('splits what waits on the viewer from what waits on everyone else', () => {
    const b = run({
      roster: [...ROSTER, member('sloane', 'human')],
      asks: [
        ask('1', 'open', 'approve', 9_000, 'nick'),
        ask('2', 'open', 'consult', 3_000, 'nick'),
        ask('3', 'open', 'consult', 5_000, 'sloane'),
        ask('4', 'open', 'consult', 5_000, null),
      ],
    });
    const w = waitingFor(b, 'nick');
    expect(w.mine.map((i) => i.ref)).toEqual(['2', '1']); // newest first: the band shows the top one
    expect(w.others).toEqual([
      { who: 'sloane', n: 1 },
      { who: 'the team', n: 1 },
    ]);
  });

  it('gives a viewer who is not signed in nothing of their own', () => {
    const b = run({ asks: [ask('1', 'open', 'approve', 9_000, 'nick')] });
    expect(waitingFor(b, null)).toEqual({ mine: [], others: [{ who: 'nick', n: 1 }] });
  });
});

describe('goalsStalled', () => {
  it('uses the protocol\'s threshold and terminal states, copied so the bundle stays light', () => {
    expect(GOAL_STALE_DAYS).toBe(PROTOCOL_STALE_DAYS);
    expect([...LANE_TERMINAL_STATES].sort()).toEqual([...PROTOCOL_TERMINAL].sort());
  });

  // The lane this exists for (nick, 2026-10-13): a plan's early increments get built, the later
  // ones sit open and unowned, and the goal reads in-flight forever. Two signals, both counted:
  // quiet (the server's stale_goals rule, ADR 487 §5.4) and orphans (open, nobody's, past the
  // same threshold).
  const DAY = 86_400_000;
  const GOALS = [
    { id: 'g1', title: 'Launch — musterd ships publicly' },
    { id: 'g2', title: 'Office liveliness — the floor is alive' },
  ];

  it('names a goal quiet when every live lane went GOAL_STALE_DAYS untouched, oldest first', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'open', { goal_id: 'g2', owner_seat: null, updated_at: NOW - 9 * DAY }),
        lane('b', 'claimed', { goal_id: 'g2', owner_seat: 'ann', updated_at: NOW - 8 * DAY }),
        lane('c', 'done', { goal_id: 'g2', updated_at: NOW - 10 * DAY }),
        lane('d', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 12 * DAY }),
      ),
    });
    expect(b.goalsStalled.map((g) => g.goalId)).toEqual(['g1', 'g2']);
    const g = b.goalsStalled[1]!;
    expect(g.name).toBe('Office liveliness');
    expect(g.quiet).toBe(true);
    expect(g.idleMs).toBe(8 * DAY);
    expect([g.done, g.total]).toEqual([1, 3]);
    expect(g.oldest).toEqual({ title: 'title a', idleMs: 9 * DAY });
  });

  it('names a moving goal too, when later lanes sit open and unowned past the threshold', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'active', { goal_id: 'g1', owner_seat: 'ann', updated_at: NOW - 60_000 }),
        lane('b', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 9 * DAY }),
        lane('c', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 20 * DAY }),
        lane('d', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 2 * DAY }),
      ),
    });
    expect(b.goalsInMotion.map((g) => g.goalId)).toEqual(['g1']);
    const g = b.goalsStalled.find((x) => x.goalId === 'g1')!;
    expect(g.quiet).toBe(false);
    expect(g.orphans).toBe(2);
    expect(g.oldest).toEqual({ title: 'title c', idleMs: 20 * DAY });
  });

  it('leaves out a goal whose lanes were touched inside the threshold, and one with nothing live', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 6 * DAY }),
        lane('b', 'claimed', { goal_id: 'g1', owner_seat: 'ann', updated_at: NOW - 60_000 }),
        lane('c', 'done', { goal_id: 'g2', updated_at: NOW - 30 * DAY }),
        lane('d', 'abandoned', { goal_id: 'g2', updated_at: NOW - 30 * DAY }),
      ),
    });
    expect(b.goalsStalled).toEqual([]);
  });

  it('ignores parked lanes and the goalless, and counts the threshold inclusively', () => {
    const b = run({
      goals: GOALS,
      board: board(
        lane('a', 'parked', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 30 * DAY }),
        lane('b', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 7 * DAY }),
        lane('c', 'open', { goal_id: null, owner_seat: null, updated_at: NOW - 30 * DAY }),
      ),
    });
    expect(b.goalsStalled.map((g) => [g.goalId, g.quiet, g.orphans, g.idleMs])).toEqual([
      ['g1', true, 1, 7 * DAY],
    ]);
  });
});
