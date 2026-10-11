import { describe, expect, it } from 'vitest';
import { checkAgainstBoard, normalizeTitle } from './check.js';
import type { ImportRow } from './rows.js';

const goal = (row: number, key: string, extra: Partial<ImportRow> = {}): ImportRow => ({
  row,
  kind: 'goal',
  key,
  title: key,
  depends_on: [],
  ...extra,
});
const lane = (row: number, extra: Partial<ImportRow> = {}): ImportRow => ({
  row,
  kind: 'lane',
  title: `Lane ${String(row)}`,
  depends_on: [],
  ...extra,
});
const empty = { goals: [], lanes: [] };
const codes = (p: ReturnType<typeof checkAgainstBoard>) =>
  p.diagnostics.map((d) => `${d.level}:${d.code}@${String(d.row)}`);

describe('checkAgainstBoard', () => {
  it('links a goal that already exists instead of re-declaring it', () => {
    const p = checkAgainstBoard([goal(2, 'launch'), lane(3, { goal: 'launch' })], {
      goals: [{ id: 'launch' }],
      lanes: [],
    });
    expect(p.goals).toEqual([]);
    expect(p.linkedGoals).toEqual(['launch']);
    expect(p.lanes[0]!.goal_id).toBe('launch');
    expect(codes(p)).toEqual(['warning:goal_exists@2']);
  });

  it('resolves lane deps to staged keys and to board lanes in any state', () => {
    const p = checkAgainstBoard(
      [
        lane(2, { key: 'b', depends_on: ['a', '01DONE0000000000000000000A'], goal: 'g' }),
        lane(3, { key: 'a', goal: 'g' }),
        goal(4, 'g'),
      ],
      { goals: [], lanes: [{ id: '01DONE0000000000000000000A', title: 'Old', state: 'done' }] },
    );
    expect(p.diagnostics).toEqual([]);
    expect(p.lanes.map((l) => l.ref)).toEqual(['lane:a', 'lane:b']); // a before b
    expect(p.lanes[1]!.depends_on).toEqual([
      { kind: 'staged', ref: 'lane:a' },
      { kind: 'existing', id: '01DONE0000000000000000000A' },
    ]);
  });

  it('errors on unresolved goal and dependency references', () => {
    const p = checkAgainstBoard(
      [
        lane(2, { goal: 'nope', depends_on: ['01M4FDBSN8'] }),
        goal(3, 'g', { depends_on: ['ghost'] }),
      ],
      empty,
    );
    expect(codes(p)).toEqual([
      'error:unresolved_goal@2',
      'error:unresolved_dependency@2',
      'error:unresolved_dependency@3',
    ]);
    expect(p.diagnostics[1]!.message).toMatch(/full lane id/);
  });

  it('errors on a lane dependency cycle and on a goal cycle', () => {
    const p = checkAgainstBoard(
      [
        goal(2, 'x', { depends_on: ['y'] }),
        goal(3, 'y', { depends_on: ['x'] }),
        lane(4, { key: 'a', depends_on: ['b'], goal: 'x' }),
        lane(5, { key: 'b', depends_on: ['a'], goal: 'x' }),
      ],
      empty,
    );
    expect(codes(p).filter((c) => c.includes('dependency_cycle'))).toEqual([
      'error:dependency_cycle@2',
      'error:dependency_cycle@4',
    ]);
  });

  it('warns on a likely duplicate of an open board lane, not a closed one, and on a lane with no goal', () => {
    const board = {
      goals: [],
      lanes: [
        { id: 'L1', title: 'Fix: the login bug', state: 'open' },
        { id: 'L2', title: 'Old thing', state: 'done' },
      ],
    };
    const p = checkAgainstBoard(
      [lane(2, { title: 'fix the  LOGIN bug' }), lane(3, { title: 'Old thing' })],
      board,
    );
    expect(codes(p)).toEqual([
      'warning:likely_duplicate@2',
      'warning:no_goal@2',
      'warning:no_goal@3',
    ]);
  });

  it('appends the source line to detail', () => {
    const p = checkAgainstBoard([lane(2, { detail: 'Body', source_ref: 'github#7' })], empty);
    expect(p.lanes[0]!.detail).toBe('Body\n\nSource: github#7');
  });

  it('normalizes titles', () => {
    expect(normalizeTitle('  Fix: the LOGIN-bug ')).toBe('fix the login bug');
  });
});
