import { describe, expect, it } from 'vitest';
import { checkAgainstBoard } from '../check.js';
import { issuesToRows, slugify } from './rows.js';
import type { TrackerIssue } from './types.js';

const v1 = { key: '3', title: 'v1.0 — First release' };
const issue = (n: number, extra: Partial<TrackerIssue> = {}): TrackerIssue => ({
  ref: `acme/app#${String(n)}`,
  title: `Issue ${String(n)}`,
  url: `https://github.com/acme/app/issues/${String(n)}`,
  ...extra,
});

describe('slugify', () => {
  it('lowercases, dashes runs, trims, cuts to 64, and falls back on the key', () => {
    expect(slugify('v1.0 — First release', '3')).toBe('v1-0-first-release');
    expect(slugify('x'.repeat(80), '3')).toHaveLength(64);
    expect(slugify('— ✨ —', '7')).toBe('group-7');
  });
});

describe('issuesToRows', () => {
  it('one goal per group, then one lane per issue carrying its ref, url first in detail', () => {
    const rows = issuesToRows([
      issue(12, { group: v1, stakes: 'high', body: 'Steps' }),
      issue(15, { group: v1 }),
      issue(16),
    ]);
    expect(rows.map((r) => [r.row, r.kind, r.key ?? null, r.goal ?? null])).toEqual([
      [1, 'goal', 'v1-0-first-release', null],
      [2, 'lane', null, 'v1-0-first-release'],
      [3, 'lane', null, 'v1-0-first-release'],
      [4, 'lane', null, null],
    ]);
    expect(rows[0]!.title).toBe('v1.0 — First release');
    expect(rows[1]).toMatchObject({
      title: 'Issue 12',
      detail: 'https://github.com/acme/app/issues/12\n\nSteps',
      stakes: 'high',
      source_ref: 'acme/app#12',
    });
    expect(rows[3]!.detail).toBe('https://github.com/acme/app/issues/16');
  });

  it('strips control characters from titles; a body keeps its line breaks', () => {
    const [goal, l] = issuesToRows([
      issue(1, {
        title: 'Fix\u001b[2J it',
        body: 'line one\nline\u0007 two',
        group: { key: '1', title: 'Q\u001b]0;x\u00074' },
      }),
    ]);
    expect(goal!.title).toBe('Q4');
    expect(l!.title).toBe('Fix it');
    expect(l!.detail).toBe('https://github.com/acme/app/issues/1\n\nline one\nline two');
  });

  it('cuts a long body to 4000 characters', () => {
    const [lane] = issuesToRows([issue(1, { body: 'b'.repeat(5000) })]);
    expect(lane!.detail).toHaveLength('https://github.com/acme/app/issues/1\n\n'.length + 4000);
  });

  it('two groups whose titles slug alike get distinct goal keys', () => {
    const rows = issuesToRows([
      issue(1, { group: { key: '1', title: 'Q4' } }),
      issue(2, { group: { key: '2', title: 'q4' } }),
    ]);
    const goals = rows.filter((r) => r.kind === 'goal').map((r) => r.key);
    expect(new Set(goals).size).toBe(2);
  });

  it('checks clean against an empty board', () => {
    const plan = checkAgainstBoard(
      issuesToRows([issue(12, { group: v1 }), issue(15, { group: v1 })]),
      { goals: [], lanes: [] },
    );
    expect(plan.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(plan.goals.map((g) => g.id)).toEqual(['v1-0-first-release']);
    expect(plan.lanes.map((l) => l.source_ref)).toEqual(['acme/app#12', 'acme/app#15']);
  });
});
