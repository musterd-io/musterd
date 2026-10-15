import { describe, expect, it } from 'vitest';
import type { Lane, LaneBoard } from '@musterd/protocol';
import { laneSeed, projectWallBoard, STICKY_CAP, STICKY_SWAY_S, stickySway, WALL_COLUMNS, withHeld, withPinned, withTaken } from './wallboard';

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

  it('carries a card\'s age to the wall, whether it arrives or the board already shows it (L5 wobble)', () => {
    const wb = projectWallBoard(board([lane({ id: 'A', state: 'active' }), lane({ id: 'C', state: 'done' })]))!;
    const arriving = withPinned(wb, [{ seed: laneSeed('A'), state: 'done', age: 0.2 }])!;
    expect(arriving.find((c) => c.key === 'done')!.stickies.find((s) => s.seed === laneSeed('A'))!.age).toBe(0.2);
    const caught = withPinned(arriving, [{ seed: laneSeed('A'), state: 'done', age: 0.5 }])!;
    expect(caught.find((c) => c.key === 'done')!.stickies.find((s) => s.seed === laneSeed('A'))!.age).toBe(0.5);
    // a card with no age stays a plain sticky
    expect(withPinned(wb, [{ seed: laneSeed('A'), state: 'done' }])!.find((c) => c.key === 'done')!.stickies.every((s) => s.age === undefined)).toBe(true);
  });

  it('returns the board untouched when nothing is pinned', () => {
    const wb = projectWallBoard(board([lane({ id: 'A' })]));
    expect(withPinned(wb, [])).toBe(wb);
    expect(withPinned(null, [{ seed: 1, state: 'done' }])).toBeNull();
  });
});

describe('projectWallBoard — stopped goals (lane 01M4V9YKMG)', () => {
  it('marks a stalled lane\'s sticky faded and pins faded cards first in their column', () => {
    const wb = projectWallBoard(
      board([
        lane({ id: 'fresh1' }),
        lane({ id: 'fresh2' }),
        lane({ id: 'stale1' }),
        lane({ id: 'fresh3' }),
        lane({ id: 'fresh4' }),
        lane({ id: 'stale2' }),
        lane({ id: 'done1', state: 'done' }),
      ]),
      new Set(['stale1', 'stale2']),
    )!;
    const open = wb[0]!;
    expect(open.count).toBe(6);
    expect(open.stickies.map((s) => [s.seed, s.faded ?? false])).toEqual([
      [laneSeed('stale1'), true],
      [laneSeed('stale2'), true],
      [laneSeed('fresh1'), false],
      [laneSeed('fresh2'), false],
    ]);
    expect(wb[5]!.stickies[0]!.faded).toBeUndefined();
  });

  it('keeps board order when nothing is stalled', () => {
    const wb = projectWallBoard(board([lane({ id: 'a' }), lane({ id: 'b' })]), new Set())!;
    expect(wb[0]!.stickies.map((s) => s.seed)).toEqual([laneSeed('a'), laneSeed('b')]);
    expect(wb[0]!.stickies.some((s) => 'faded' in s)).toBe(false);
  });
});

describe('stickySway — a landed card swings where a viewer can see it (L5 follow-up)', () => {
  const peak = (from: number, to: number) => {
    let m = 0;
    for (let a = from; a < to; a += 0.005) m = Math.max(m, Math.abs(stickySway(a)));
    return m;
  };
  it('peaks at 3+ board units (a 17-unit card: ~2 px at 1280 wide; the first cut peaked at 1.7)', () => {
    expect(peak(0, STICKY_SWAY_S)).toBeGreaterThanOrEqual(3);
  });
  it('swings twice, not once: the second swing is the opposite way and still visible', () => {
    expect(peak(0.25, 0.5)).toBeGreaterThan(1);
    const early = stickySway(0.11);
    const later = stickySway(0.33);
    expect(Math.sign(early)).toBe(-Math.sign(later));
  });
  it('hangs still before it landed and after the sway is over', () => {
    expect(stickySway(undefined)).toBe(0);
    expect(stickySway(-1)).toBe(0);
    expect(stickySway(STICKY_SWAY_S)).toBe(0);
    expect(stickySway(5)).toBe(0);
  });
  it('is small enough to settle: by the end the swing is under half a unit', () => {
    expect(Math.abs(stickySway(STICKY_SWAY_S - 0.01))).toBeLessThan(0.5);
  });
});

describe('withHeld — the cork remembers where cards hung (lane 01M4VP3V99)', () => {
  const wb = (ids: Array<[string, Lane['state']]>) =>
    projectWallBoard(board(ids.map(([id, state]) => lane({ id, state }))))!;
  const heldOf = (b: ReturnType<typeof withHeld>['board'], key: string) => b!.find((c) => c.key === key)!.held;

  it('raises a column\'s mark to the cards seen hanging there, up to the sticky cap', () => {
    const r = withHeld(wb([['A', 'active'], ['B', 'active']]), {});
    expect(r.changed).toBe(true);
    expect(r.marks.active).toBe(2);
    expect(heldOf(r.board, 'active')).toBe(2);
    const many = withHeld(wb(Array.from({ length: STICKY_CAP + 3 }, (_, i) => [`L${i}`, 'done'] as [string, Lane['state']])), {});
    expect(many.marks.done).toBe(STICKY_CAP);
  });

  it('never lowers a mark: a card that moved on leaves its hole behind', () => {
    const first = withHeld(wb([['A', 'active'], ['B', 'active']]), {});
    const later = withHeld(wb([['A', 'active']]), first.marks); // B left
    expect(later.changed).toBe(false);
    expect(later.marks.active).toBe(2);
    expect(heldOf(later.board, 'active')).toBe(2); // one card hanging, two slots held: one hole
  });

  it('leaves a column that never held a card unmarked', () => {
    const r = withHeld(wb([['A', 'active']]), {});
    expect(heldOf(r.board, 'blocked')).toBeUndefined();
    expect(r.marks.blocked).toBeUndefined();
  });

  it('passes a missing board through', () => {
    expect(withHeld(null, { done: 2 })).toEqual({ board: null, marks: { done: 2 }, changed: false });
  });
});
