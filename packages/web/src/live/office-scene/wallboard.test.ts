import { describe, expect, it } from 'vitest';
import type { Lane, LaneBoard } from '@musterd/protocol';
import { GOAL_ROWS, laneSeed, projectWallBoard, READ_PIN_CAP, readPins, seededPlace, STICKY_SWAY_S, stickySway, WALL_COLUMNS, withPinned, withTaken } from './wallboard';

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

  it('pins every lane, however many: a pile, not a cap (ADR 751)', () => {
    const many = Array.from({ length: 30 }, (_, i) => lane({ id: `L${i}`, state: 'open' }));
    const open = projectWallBoard(board(many))!.find((c) => c.key === 'open')!;
    expect(open.stickies).toHaveLength(30);
    expect(open.count).toBe(30);
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
  it("marks a stalled lane's sticky faded, in its place like any other", () => {
    const wb = projectWallBoard(
      board([lane({ id: 'fresh1' }), lane({ id: 'stale1' }), lane({ id: 'done1', state: 'done' })]),
      new Set(['stale1']),
    )!;
    const open = wb[0]!;
    expect(open.stickies.map((s) => [s.seed, s.faded ?? false])).toEqual([
      [laneSeed('fresh1'), false],
      [laneSeed('stale1'), true],
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

describe('pin holes, derived from the board (lane 01M50WEBTC)', () => {
  const NOW = 100 * 86_400_000;
  const DAY = 86_400_000;
  const holesOf = (b: ReturnType<typeof projectWallBoard>, key: string) => b!.find((c) => c.key === key)!.holes;
  const wb = (lanes: Lane[]) => projectWallBoard(board(lanes), new Set(), NOW);

  it('keeps a hole in every column a recent lane passed, in its own row', () => {
    // A finished this week, so it passed open, claimed, active and awaiting on its way to done.
    const b = wb([lane({ id: 'A', state: 'done', updated_at: NOW - 2 * DAY })]);
    for (const key of ['open', 'claimed', 'active', 'awaiting_acceptance']) expect(holesOf(b, key)).toHaveLength(1);
    expect(holesOf(b, 'done')).toBeUndefined(); // it hangs there now
    expect(holesOf(b, 'blocked')).toBeUndefined();
    expect(holesOf(b, 'open')![0]!.row).toBe(0);
  });

  it('forgets lanes that moved on more than seven days ago', () => {
    expect(holesOf(wb([lane({ id: 'A', state: 'done', updated_at: NOW - 8 * DAY })]), 'active')).toBeUndefined();
  });

  it('a blocked lane passed open and claimed, never active', () => {
    const b = wb([lane({ id: 'A', state: 'blocked', updated_at: NOW })]);
    expect(holesOf(b, 'claimed')).toHaveLength(1);
    expect(holesOf(b, 'active')).toBeUndefined();
  });

  it('is the same cork for every viewer: a pure function of the board', () => {
    const lanes = [lane({ id: 'A', state: 'awaiting_acceptance', updated_at: NOW - DAY }), lane({ id: 'B', state: 'open' })];
    expect(wb(lanes)).toEqual(wb(lanes));
  });
});

describe('goal rows and places (ADR 751)', () => {
  it('gives each goal with a card a row, in the team\'s order, then one row for the rest', () => {
    const b = projectWallBoard(
      board([
        lane({ id: 'a', goal_id: 'cloud' }),
        lane({ id: 'b', goal_id: 'security' }),
        lane({ id: 'c', goal_id: null }),
        lane({ id: 'd', goal_id: 'nobody-ordered-this' }),
      ]),
      new Set(),
      1,
      [],
      ['security', 'launch', 'cloud'],
    )!;
    expect(b.rows!.map((r) => [r.goalId, r.label])).toEqual([
      ['security', 'security'],
      ['cloud', 'cloud'],
      [null, 'other'],
    ]);
    const open = b[0]!.stickies;
    const rowOf = (id: string) => open.find((s) => s.seed === laneSeed(id))!.row;
    expect([rowOf('a'), rowOf('b'), rowOf('c'), rowOf('d')]).toEqual([1, 0, 2, 2]);
  });

  it('takes at most GOAL_ROWS goals; the rest share the last row', () => {
    const goals = Array.from({ length: GOAL_ROWS + 2 }, (_, i) => `g${i}`);
    const b = projectWallBoard(board(goals.map((g) => lane({ id: g, goal_id: g }))), new Set(), 1, [], goals)!;
    expect(b.rows).toHaveLength(GOAL_ROWS + 1);
    expect(b.rows!.at(-1)!.goalId).toBeNull();
  });

  it('a board with no goals is one unlabelled row', () => {
    expect(projectWallBoard(board([lane()]))!.rows).toEqual([{ goalId: null, label: '', tone: GOAL_ROWS }]);
  });

  it("hangs a card at the daemon's recorded place, else a seeded one that never moves", () => {
    const placed = projectWallBoard(board([lane({ card: { x: 0.25, y: 0.75, by: 'ada', at: 9 } })]))!;
    expect(placed[0]!.stickies[0]).toMatchObject({ x: 0.25, y: 0.75, at: 9 });
    const seeded = projectWallBoard(board([lane()]))!;
    expect(seeded[0]!.stickies[0]).toMatchObject(seededPlace(laneSeed('L1')));
  });

  it('paints a cell oldest first, so the newest card is on top of its pile', () => {
    const b = projectWallBoard(
      board([
        lane({ id: 'new', card: { x: 0.5, y: 0.5, by: 'a', at: 20 } }),
        lane({ id: 'old', card: { x: 0.5, y: 0.5, by: 'a', at: 10 } }),
      ]),
    )!;
    expect(b[0]!.stickies.map((s) => s.seed)).toEqual([laneSeed('old'), laneSeed('new')]);
  });

  it('a pinned card keeps its row and place as it moves column', () => {
    const b = projectWallBoard(board([lane({ id: 'a', goal_id: 'g', card: { x: 0.2, y: 0.3, by: 'a', at: 1 } })]), new Set(), 1, [], ['g'])!;
    const moved = withPinned(b, [{ seed: laneSeed('a'), state: 'awaiting_acceptance' }])!;
    expect(moved[4]!.stickies[0]).toMatchObject({ row: 0, x: 0.2, y: 0.3 });
    expect(moved.rows).toEqual(b.rows);
  });
});

describe('read pins (ADR 644 inc 3)', () => {
  const board: LaneBoard = { lanes: [lane({ id: 'a', state: 'open' })], warnings: [] } as unknown as LaneBoard;

  it('carries the reads it is given, in order, and none when there are none', () => {
    expect(projectWallBoard(board, new Set(), 1, ['due', 'waiting'])!.reads).toEqual(['due', 'waiting']);
    expect(projectWallBoard(board, new Set(), 1)!.reads).toBeUndefined();
  });

  it('keeps the reads through a card in hand and a card being pinned', () => {
    const wb = projectWallBoard(board, new Set(), 1, ['overdue'])!;
    const seed = laneSeed('a');
    expect(withTaken(wb, [seed])!.reads).toEqual(['overdue']);
    expect(withPinned(wb, [{ seed, state: 'claimed' }])!.reads).toEqual(['overdue']);
  });

  it('pins every read that fits, and past the cap makes the last slot a "+"', () => {
    expect(readPins(undefined)).toEqual([]);
    const eight = Array<'waiting'>(READ_PIN_CAP).fill('waiting');
    expect(readPins(eight)).toEqual(eight);
    const nine = ['overdue', ...eight] as const;
    const pins = readPins(nine);
    expect(pins).toHaveLength(READ_PIN_CAP);
    expect(pins[0]).toBe('overdue');
    expect(pins.at(-1)).toBe('more');
  });
});
