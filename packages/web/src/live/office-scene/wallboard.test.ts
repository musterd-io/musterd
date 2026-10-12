import { describe, expect, it } from 'vitest';
import type { Lane, LaneBoard } from '@musterd/protocol';
import { laneSeed, projectWallBoard, STICKY_CAP, WALL_COLUMNS, withPinned, withTaken } from './wallboard';

const lane = (over: Partial<Lane> = {}): Lane => ({
  id: 'L1',
  team: 'revive',
  project: 'default',
  title: 'write the launch post',
  detail: null,
  owner_seat: null,
  role: null,
  scope: [],
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

const board = (lanes: Lane[]): LaneBoard => ({ lanes, warnings: [] });

describe('projectWallBoard — the board squinted at from across the room', () => {
  it('null in, null out — no board is not an empty board', () => {
    expect(projectWallBoard(null)).toBeNull();
  });

  it('an empty board still stands up all six columns, each bare', () => {
    const wall = projectWallBoard(board([]))!;
    expect(wall.map((c) => c.key)).toEqual([...WALL_COLUMNS]);
    for (const col of wall) {
      expect(col.count).toBe(0);
      expect(col.stickies).toEqual([]);
    }
  });

  it('lanes land in their state column, board order preserved', () => {
    const wall = projectWallBoard(
      board([
        lane({ id: 'a', state: 'active' }),
        lane({ id: 'b', state: 'open' }),
        lane({ id: 'c', state: 'active' }),
      ]),
    )!;
    const active = wall.find((c) => c.key === 'active')!;
    expect(active.count).toBe(2);
    expect(active.stickies.map((s) => s.seed)).toEqual([laneSeed('a'), laneSeed('c')]);
    expect(wall.find((c) => c.key === 'open')!.count).toBe(1);
  });

  it('caps stickies per column but keeps the true count for the badge', () => {
    const many = Array.from({ length: STICKY_CAP + 3 }, (_, i) =>
      lane({ id: `L${i}`, state: 'open' }),
    );
    const open = projectWallBoard(board(many))!.find((c) => c.key === 'open')!;
    expect(open.stickies).toHaveLength(STICKY_CAP);
    expect(open.count).toBe(STICKY_CAP + 3);
  });

  it('ready_for_review folds into awaiting_acceptance (ADR 192), keeping its own state on the note', () => {
    const wall = projectWallBoard(
      board([lane({ id: 'r', state: 'ready_for_review' }), lane({ id: 'w', state: 'awaiting_acceptance' })]),
    )!;
    const col = wall.find((c) => c.key === 'awaiting_acceptance')!;
    expect(col.count).toBe(2);
    expect(col.stickies.map((s) => s.state)).toEqual(['ready_for_review', 'awaiting_acceptance']);
    expect(wall.some((c) => (c.key as string) === 'ready_for_review')).toBe(false);
  });

  it('abandoned lanes fall off the wall entirely', () => {
    const wall = projectWallBoard(board([lane({ id: 'x', state: 'abandoned' })]))!;
    expect(wall.every((c) => c.count === 0)).toBe(true);
  });

  it('seeds are stable per lane id and differ across ids', () => {
    expect(laneSeed('01KYX3DA20')).toBe(laneSeed('01KYX3DA20'));
    expect(laneSeed('a')).not.toBe(laneSeed('b'));
  });
});

describe('withTaken — a card someone has walked off with', () => {
  it('marks the lane taken in the open column only, keeping its slot', () => {
    const wb = projectWallBoard(
      board([lane({ id: 'A', state: 'open' }), lane({ id: 'B', state: 'open' }), lane({ id: 'A2', state: 'claimed' })]),
    )!;
    const out = withTaken(wb, [laneSeed('A'), laneSeed('A2')])!;
    const open = out.find((c) => c.key === 'open')!;
    expect(open.stickies.map((s) => s.taken === true)).toEqual([true, false]);
    const claimed = out.find((c) => c.key === 'claimed')!;
    expect(claimed.stickies.every((s) => !s.taken)).toBe(true);
  });

  it('returns the board untouched when nothing is taken', () => {
    const wb = projectWallBoard(board([lane({ id: 'A' })]));
    expect(withTaken(wb, [])).toBe(wb);
    expect(withTaken(null, [1])).toBeNull();
  });
});

describe('withPinned — a card someone has just pinned back on the wall', () => {
  it('moves the lane to its new column, one card on the wall either way', () => {
    const wb = projectWallBoard(
      board([lane({ id: 'A', state: 'active' }), lane({ id: 'B', state: 'active' }), lane({ id: 'C', state: 'done' })]),
    )!;
    const out = withPinned(wb, [{ seed: laneSeed('A'), state: 'done' }])!;
    expect(out.find((c) => c.key === 'active')!.stickies.map((s) => s.seed)).toEqual([laneSeed('B')]);
    expect(out.find((c) => c.key === 'done')!.stickies.map((s) => s.seed)).toEqual([laneSeed('C'), laneSeed('A')]);
    // the board caught up: the pin is a no-op, column objects untouched
    const caught = withPinned(out, [{ seed: laneSeed('A'), state: 'done' }])!;
    expect(caught.find((c) => c.key === 'done')).toBe(out.find((c) => c.key === 'done'));
  });

  it('returns the board untouched when nothing is pinned', () => {
    const wb = projectWallBoard(board([lane({ id: 'A' })]));
    expect(withPinned(wb, [])).toBe(wb);
    expect(withPinned(null, [{ seed: 1, state: 'done' }])).toBeNull();
  });
});
