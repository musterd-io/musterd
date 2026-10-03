/*
 * The radar's weekly tick (ADR 056 ingest; lane 01M3TAKHQ4, recovered by the nothing-vanishes triage).
 *
 * What runs on a schedule is the DRY sweep — fetch + dedup, no key, no write — and one line to the
 * team saying how many candidates are waiting and how old the last digest is. The triaged emit
 * (`--triage --emit`) stays a hand-run step: it spends a human's ANTHROPIC_API_KEY and writes a
 * digest file the repo has to carry in a PR, and research-radar-plan.md §8 (nick, 2026-08-24)
 * defers its schedule until a few real digests exist. This tick is what makes "nothing runs" false
 * without crossing that line: the team is told, weekly, that the hand-run step is due.
 *
 * Scheduled by the ADR 166 sweep LaunchAgent, which spawns `sweep.ts --weekly --post` every tick;
 * `--weekly` is a 7-day stamp, so 2,015 of every 2,016 ticks read one file and exit.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SweepReport } from './types.ts';

export const WEEK_MS = 7 * 86_400_000;
export const RADAR_STAMP = join(homedir(), '.musterd', 'sweep', 'radar-sweep.last');

/** The newest `YYYY-WW.md` digest in the radar dir, or null when none has been emitted. */
export function latestDigestWeek(radarDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(radarDir);
  } catch {
    return null;
  }
  const weeks = names
    .map((n) => /^(\d{4}-W\d{2})\.md$/.exec(n)?.[1])
    .filter((w): w is string => w !== undefined)
    .sort();
  return weeks.at(-1) ?? null;
}

/** ISO week `YYYY-WW` → the UTC Monday that starts it. */
export function isoWeekStart(week: string): Date | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const wk = Number(m[2]);
  // ISO 8601: week 1 is the week with January 4th in it.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * 86_400_000);
  return new Date(week1Monday.getTime() + (wk - 1) * WEEK_MS);
}

/**
 * The one line the team reads. Counts from the dry sweep, the last digest's age, and the hand-run
 * command — a pointer, not a report (ADR 338's posture): the digest is where the papers are.
 */
export function weeklySummary(
  report: Pick<SweepReport, 'since_days' | 'new_count' | 'new' | 'warnings'>,
  latestDigest: string | null,
  now: number,
): string {
  const by = { arxiv: 0, hf: 0, exn: 0 } as Record<string, number>;
  for (const c of report.new) by[c.source] = (by[c.source] ?? 0) + 1;
  const sources = Object.entries(by)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
  const start = latestDigest ? isoWeekStart(latestDigest) : null;
  const age = start ? Math.floor((now - start.getTime()) / WEEK_MS) : null;
  const last = latestDigest
    ? `last digest ${latestDigest}${age !== null ? ` (${age}w ago)` : ''}`
    : 'no digest emitted yet';
  const head =
    report.new_count === 0
      ? `research radar (ADR 056): nothing new in the last ${report.since_days}d — ${last}`
      : `research radar (ADR 056): ${report.new_count} new candidate(s) in the last ${report.since_days}d` +
        (sources ? ` (${sources})` : '') +
        ` — ${last}`;
  const lines = [head];
  if (report.new_count > 0 || (age !== null && age >= 2))
    lines.push('triage + emit by hand: pnpm radar:sweep --triage --emit (needs ANTHROPIC_API_KEY)');
  for (const w of report.warnings) lines.push(`⚠ ${w}`);
  return lines.join('\n');
}

export function dueThisWeek(now: number, stamp = RADAR_STAMP): boolean {
  try {
    return now - Number(readFileSync(stamp, 'utf8').trim()) >= WEEK_MS;
  } catch {
    return true;
  }
}

export function markRan(now: number, stamp = RADAR_STAMP): void {
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, String(now));
}

/** True when a run should consider posting at all — the sweep seat's token exists on this machine. */
export function sweepTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['MUSTERD_SERVICE_TOKEN_FILE'] ?? join(homedir(), '.musterd', 'sweep', 'seat-token');
}

export function readSweepToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = sweepTokenPath(env);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
