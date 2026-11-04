/**
 * Corpus backup staleness check (ADR 798). Exit 1 when the newest local snapshot or the last
 * verified off-machine upload is older than the bound, or missing entirely. This is the check
 * whose absence let the snapshot cadence lapse from 2026-09-05 to 2026-11-04 unnoticed: it must
 * be able to fail on a date rollover with no code change.
 *
 *   node scripts/corpus/check.ts [--max-age-days 14]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MAX_AGE_DAYS = 14;

export interface FreshnessInput {
  snapshotDirs: string[];
  lastUploadAt: string | null;
  now: Date;
  maxAgeDays: number;
}

export function snapshotStampMs(name: string): number | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

export function checkFreshness(input: FreshnessInput): string[] {
  const problems: string[] = [];
  const bound = input.maxAgeDays * 86400000;
  const stamps = input.snapshotDirs.map(snapshotStampMs).filter((n): n is number => n !== null);
  if (stamps.length === 0) {
    problems.push('no corpus snapshot directories found');
  } else {
    const age = input.now.getTime() - Math.max(...stamps);
    if (age > bound) {
      problems.push(
        `newest corpus snapshot is ${(age / 86400000).toFixed(1)}d old (bound ${input.maxAgeDays}d)`,
      );
    }
  }
  if (input.lastUploadAt === null) {
    problems.push('no verified off-machine upload on record (LAST.json missing)');
  } else {
    const at = Date.parse(input.lastUploadAt);
    if (Number.isNaN(at))
      problems.push(`LAST.json uploaded_at is not a date: ${input.lastUploadAt}`);
    else if (input.now.getTime() - at > bound) {
      problems.push(
        `last verified off-machine upload is ${((input.now.getTime() - at) / 86400000).toFixed(1)}d old (bound ${input.maxAgeDays}d)`,
      );
    }
  }
  return problems;
}

export function readFreshness(
  home: string = homedir(),
  now: Date = new Date(),
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): FreshnessInput {
  const snapDir = join(home, '.musterd', 'corpus-snapshots');
  const snapshotDirs = existsSync(snapDir)
    ? readdirSync(snapDir).filter((n) => statSync(join(snapDir, n)).isDirectory())
    : [];
  const lastPath = join(home, '.musterd', 'corpus-backups', 'LAST.json');
  let lastUploadAt: string | null = null;
  if (existsSync(lastPath)) {
    try {
      lastUploadAt =
        (JSON.parse(readFileSync(lastPath, 'utf8')) as { uploaded_at?: string }).uploaded_at ??
        null;
    } catch {
      lastUploadAt = 'unreadable';
    }
  }
  return { snapshotDirs, lastUploadAt, now, maxAgeDays };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.indexOf('--max-age-days');
  const maxAgeDays = arg >= 0 ? Number(process.argv[arg + 1]) : DEFAULT_MAX_AGE_DAYS;
  const problems = checkFreshness(readFreshness(homedir(), new Date(), maxAgeDays));
  if (problems.length === 0) {
    console.log(`ok corpus backup: snapshot and verified upload within ${maxAgeDays}d`);
    process.exit(0);
  }
  for (const p of problems) console.error(`corpus backup STALE: ${p}`);
  console.error('run: pnpm corpus:backup');
  process.exit(1);
}
