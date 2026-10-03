import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from './sweep.ts';
import {
  dueThisWeek,
  isoWeekStart,
  latestDigestWeek,
  markRan,
  WEEK_MS,
  weeklySummary,
} from './weekly.ts';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'radar-weekly-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cand = (source: 'arxiv' | 'hf' | 'exn', id: string) => ({
  source,
  id,
  title: 't',
  url: 'https://x',
  published: '2026-10-01',
  abstract: '',
});

describe('the radar weekly tick (lane 01M3TAKHQ4)', () => {
  it('finds the newest digest week in the radar dir, and null when none exists', () => {
    const d = temp();
    expect(latestDigestWeek(d)).toBeNull();
    for (const n of ['2026-W36.md', 'README.md', 'seen.json', '2026-W40.md', 'prompts'])
      writeFileSync(join(d, n), '');
    expect(latestDigestWeek(d)).toBe('2026-W40');
    expect(latestDigestWeek(join(d, 'missing'))).toBeNull();
  });

  it('turns an ISO week into its Monday', () => {
    expect(isoWeekStart('2026-W36')?.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(isoWeekStart('2026-W01')?.toISOString()).toBe('2025-12-29T00:00:00.000Z');
    expect(isoWeekStart('nope')).toBeNull();
  });

  it('summarises counts by source, the last digest age, and the hand-run command', () => {
    const now = Date.UTC(2026, 9, 3); // 2026-10-03, ISO week 40
    const out = weeklySummary(
      {
        since_days: 14,
        new_count: 3,
        new: [cand('arxiv', 'a'), cand('arxiv', 'b'), cand('hf', 'c')],
        warnings: ['hf: rate limited'],
      },
      '2026-W36',
      now,
    );
    expect(out.split('\n')).toEqual([
      'research radar (ADR 056): 3 new candidate(s) in the last 14d (2 arxiv · 1 hf) — last digest 2026-W36 (4w ago)',
      'triage + emit by hand: pnpm radar:sweep --triage --emit (needs ANTHROPIC_API_KEY)',
      '⚠ hf: rate limited',
    ]);
  });

  it('says so when nothing is new, and still nudges when the last digest is old', () => {
    const now = Date.UTC(2026, 9, 3);
    expect(
      weeklySummary({ since_days: 7, new_count: 0, new: [], warnings: [] }, '2026-W39', now),
    ).toBe('research radar (ADR 056): nothing new in the last 7d — last digest 2026-W39 (1w ago)');
    expect(
      weeklySummary({ since_days: 7, new_count: 0, new: [], warnings: [] }, null, now).split('\n'),
    ).toEqual(['research radar (ADR 056): nothing new in the last 7d — no digest emitted yet']);
    expect(
      weeklySummary({ since_days: 7, new_count: 0, new: [], warnings: [] }, '2026-W36', now).split(
        '\n',
      ),
    ).toHaveLength(2);
  });

  it('the weekly stamp admits one run per seven days', () => {
    const stamp = join(temp(), 'radar-sweep.last');
    const t0 = 1_790_000_000_000;
    expect(dueThisWeek(t0, stamp)).toBe(true);
    markRan(t0, stamp);
    expect(dueThisWeek(t0 + WEEK_MS - 1, stamp)).toBe(false);
    expect(dueThisWeek(t0 + WEEK_MS, stamp)).toBe(true);
  });

  it('parseArgs accepts --weekly and --post, which never imply --triage', () => {
    const args = parseArgs(['--weekly', '--post', '--limit', '50']);
    expect(args).toMatchObject({ weekly: true, post: true, triage: false, emit: false, limit: 50 });
    expect(parseArgs([])).toMatchObject({ weekly: false, post: false });
  });
});
