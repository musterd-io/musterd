import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { AskView } from './asks';
import { briefing, SHIPPED_WINDOW_MS } from './briefing';

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

  it('survives a lane with no owner and no goal', () => {
    const b = run({ board: board(lane('x', 'blocked', { owner_seat: null })) });
    expect(b.needsHuman[0]!.owner).toBeNull();
    const w = run({ board: board(lane('y', 'active', { owner_seat: null })) });
    expect(w.inProgress[0]).toMatchObject({ owner: null, goal: null });
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
});
