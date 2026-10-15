import { describe, expect, it } from 'vitest';
import type { Goal, Lane } from '@musterd/protocol';
import { buildGoalTable, QUIET_MS } from './goalTable';

const lane = (over: Partial<Lane> = {}): Lane => ({
  id: 'L1',
  team: 'revive',
  project: 'default',
  title: 'write the launch post',
  detail: null,
  owner_seat: null,
  role: null,
  scope: [],
  areas: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  stakes: 'normal' as const,
  stakes_provenance: 'declared' as const,
  merged: null,
  state: 'open',
  created_by: 'nick',
  created_at: 1,
  claimed_at: null,
  resolved_at: null,
  updated_at: 1,
  ...over,
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  title: 'Cloud',
  wave: null,
  depends_on: [],
  declared_by: 'nick',
  declared_at: 1,
  status: 'in-flight',
  epoch: 0,
  ...over,
});

const NOW = 100 * 86_400_000;

describe('buildGoalTable — nick’s board questions as one table (board readability inc 2)', () => {
  it('counts owners per goal over live lanes, most first, and the unowned beside them', () => {
    const rows = buildGoalTable(
      [
        lane({ id: 'a', goal_id: 'g1', state: 'active', owner_seat: 'fifty', updated_at: NOW }),
        lane({ id: 'b', goal_id: 'g1', state: 'claimed', owner_seat: 'fifty', updated_at: NOW }),
        lane({ id: 'c', goal_id: 'g1', state: 'blocked', owner_seat: 'lazara', updated_at: NOW }),
        lane({ id: 'd', goal_id: 'g1', state: 'open', updated_at: NOW }),
        lane({ id: 'e', goal_id: 'g1', state: 'blocked', updated_at: NOW }),
        // Shipped, dropped and shelved work owns nothing live.
        lane({ id: 'f', goal_id: 'g1', state: 'done', owner_seat: 'ghost', updated_at: NOW }),
        lane({ id: 'g', goal_id: 'g1', state: 'abandoned', owner_seat: 'ghost', updated_at: NOW }),
        lane({ id: 'h', goal_id: 'g1', state: 'parked', updated_at: NOW }),
      ],
      [goal()],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'g1',
      title: 'Cloud',
      owners: [
        { seat: 'fifty', n: 2 },
        { seat: 'lazara', n: 1 },
      ],
      unowned: 2,
      blocked: 2,
      live: 5,
    });
  });

  it('names who the review lanes wait on, once each, and counts the ones nobody holds', () => {
    const [row] = buildGoalTable(
      [
        lane({ id: 'a', goal_id: 'g1', state: 'awaiting_acceptance', acceptance_reviewer: 'dreamy' }),
        lane({ id: 'b', goal_id: 'g1', state: 'ready_for_review', acceptance_reviewer: 'dreamy' }),
        lane({ id: 'c', goal_id: 'g1', state: 'awaiting_acceptance', acceptance_reviewer: 'ghost' }),
        lane({ id: 'd', goal_id: 'g1', state: 'awaiting_acceptance' }),
      ],
      [goal()],
      NOW,
    );
    expect(row!.review).toBe(4);
    expect(row!.reviewers).toEqual(['dreamy', 'ghost']);
  });

  it('counts quiet lanes — live and untouched for the threshold — as what got lost', () => {
    const [row] = buildGoalTable(
      [
        lane({ id: 'old', goal_id: 'g1', state: 'claimed', owner_seat: 'nick', updated_at: NOW - QUIET_MS - 1 }),
        lane({ id: 'fresh', goal_id: 'g1', state: 'open', updated_at: NOW - 1000 }),
        lane({ id: 'gone', goal_id: 'g1', state: 'done', updated_at: 1 }),
      ],
      [goal()],
      NOW,
    );
    expect(row!.quiet).toBe(1);
  });

  it('says who owns the most recently moved live lane, and when', () => {
    const [row] = buildGoalTable(
      [
        lane({ id: 'a', goal_id: 'g1', title: 'older', state: 'active', owner_seat: 'fifty', updated_at: NOW - 5000 }),
        lane({ id: 'b', goal_id: 'g1', title: 'newest', state: 'open', updated_at: NOW - 10 }),
      ],
      [goal()],
      NOW,
    );
    expect(row!.lastMoved).toEqual({ lane: 'b', title: 'newest', owner: null, at: NOW - 10 });
  });

  it('follows the grid’s order and keeps "not on a goal" last; shipped goals drop out', () => {
    const rows = buildGoalTable(
      [
        lane({ id: 'a', goal_id: 'g2', state: 'open' }),
        lane({ id: 'b', goal_id: null, state: 'open', owner_seat: 'nick' }),
        lane({ id: 'c', goal_id: 'ghost-goal', state: 'open' }),
        lane({ id: 'd', goal_id: 'g3', state: 'done' }),
      ],
      [
        goal({ id: 'g2', title: 'Security' }),
        goal({ id: 'g3', title: 'Old', status: 'shipped' }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(['g2', 'ghost-goal', null]);
    expect(rows.at(-1)).toMatchObject({ title: 'Not on a goal yet', owners: [{ seat: 'nick', n: 1 }] });
  });

  it('gives each row its state mix for the bar, and a short name cut at the dash', () => {
    const [row] = buildGoalTable(
      [
        lane({ id: 'a', goal_id: 'g1', state: 'open' }),
        lane({ id: 'b', goal_id: 'g1', state: 'claimed', owner_seat: 'x' }),
        lane({ id: 'c', goal_id: 'g1', state: 'active', owner_seat: 'x' }),
        lane({ id: 'd', goal_id: 'g1', state: 'blocked', owner_seat: 'x' }),
        lane({ id: 'e', goal_id: 'g1', state: 'awaiting_acceptance', owner_seat: 'x' }),
      ],
      [goal({ title: 'musterd Cloud — hosted teams: sign up, get a team' })],
      NOW,
    );
    expect(row!.mix).toEqual({ open: 1, working: 2, blocked: 1, review: 1 });
    expect(row!.name).toBe('musterd Cloud');
    expect(row!.title).toBe('musterd Cloud — hosted teams: sign up, get a team');
    expect(row!.blurb).toBe('hosted teams: sign up, get a team');
    const [withStory] = buildGoalTable(
      [lane({ id: 'z', goal_id: 'g1' })],
      [goal({ title: 'Cloud — x', story: 'Join from anywhere.' })],
      NOW,
    );
    expect(withStory!.blurb).toBe('Join from anywhere.');
  });
});
