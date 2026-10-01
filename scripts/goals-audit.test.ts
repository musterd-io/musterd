import { describe, expect, it } from 'vitest';
import { leftoverSignal } from '@musterd/protocol';
import {
  type AuditLane,
  auditBody,
  auditFindings,
  FOLLOWS_UP_SINCE,
  TODOS_STALE_MS,
} from './goals-audit.ts';
import type { IncrementItem } from './intents.ts';

const NOW = FOLLOWS_UP_SINCE + 30 * 86_400_000;
const lane = (id: string, extra: Partial<AuditLane> = {}): AuditLane => ({
  id,
  title: id,
  detail: null,
  state: 'done',
  goal_id: null,
  resolved_at: NOW - 1000,
  ...extra,
});
const item = (text: string, cited: boolean): IncrementItem => ({
  file: 'docs/superpowers/specs/x.md',
  line: 1,
  section: 'Increments',
  text,
  cited,
});
const run = (
  lanes: AuditLane[],
  goals = [] as { id: string; status: string }[],
  items = [] as IncrementItem[],
) => auditFindings({ lanes, goals, items, now: NOW, signal: (l) => leftoverSignal(l) });

const L1 = '01M3T8MJK8H4M86DZJEBMW6KM8';

describe('auditFindings — the three cheap checks (ADR 487 §5.4)', () => {
  it('1: a shipped goal whose plan section still lists increments with no lane', () => {
    const out = run(
      [lane(L1, { goal_id: 'g' })],
      [{ id: 'g', status: 'shipped' }],
      [item(`| 1 | \`${L1}\` | done |`, true), item('| 2 | later | — |', false)],
    );
    expect(out).toEqual([
      'goal g reads shipped, but docs/superpowers/specs/x.md §Increments lists 1 increment(s) with no lane',
    ]);
  });

  it('1: silent while the goal is in flight, or when every row cites a lane', () => {
    expect(
      run(
        [lane(L1, { goal_id: 'g' })],
        [{ id: 'g', status: 'in-flight' }],
        [item(`| 1 | ${L1} |`, true), item('| 2 | later |', false)],
      ),
    ).toEqual([]);
    expect(
      run([lane(L1, { goal_id: 'g' })], [{ id: 'g', status: 'shipped' }], [item(L1, true)]),
    ).toEqual([]);
  });

  it('2: a part-of-several lane closed after lane 3 with no follows_up', () => {
    expect(run([lane('A', { title: 'work 2/5' })])).toEqual([
      'lane A "work 2/5" closed as "2/5" with no follows_up',
    ]);
  });

  it('2: not before lane 3 existed, not when answered, not for one-shot work', () => {
    expect(
      run([
        lane('A', { title: 'work 2/5', resolved_at: FOLLOWS_UP_SINCE - 1 }),
        lane('B', { title: 'work 2/5', follows_up: 'none' }),
        lane('C', { title: 'fix it' }),
      ]),
    ).toEqual([]);
  });

  it('3: unfinished to-dos a week old with no answer', () => {
    const t = { items: ['docs'], at: NOW - TODOS_STALE_MS - 86_400_000 };
    expect(run([lane('A', { title: 'fix it', state: 'active', unfinished_todos: t })])).toEqual([
      'lane A "fix it" has 1 unfinished to-do(s) from 8d ago',
    ]);
    expect(
      run([
        lane('A', {
          title: 'fix it',
          state: 'active',
          unfinished_todos: { items: ['x'], at: NOW - 1000 },
        }),
      ]),
    ).toEqual([]);
  });
});

describe('auditBody — one post, a pointer not a report', () => {
  it('caps the list at eight and says where the rest are', () => {
    const body = auditBody(Array.from({ length: 10 }, (_, i) => `f${i}`));
    expect(body.split('\n')).toHaveLength(10);
    expect(body).toContain('…and 2 more (pnpm goals:audit)');
  });
});
