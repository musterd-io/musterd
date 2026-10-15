import type { CiRunSample, CiTrend, CiWindow } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';

/** ADR 610: the trend window. Two of them are compared, so a reader sees drift, not a number. */
export const CI_TREND_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ADR 610: completed CI runs as append-only `ci.run_measured` rows, one per forge run id. The
 * sampler reads the forge from the outside and may hand the same run in on every tick, so the
 * run id is the dedupe key: a second sighting writes nothing. Returns how many rows were new.
 *
 * The row's `ts` is the sampling time (the ledger stamps its own clock); the run's own creation
 * time rides in `detail.created_at`, and the trend buckets by THAT — a sampler catching up after a
 * laptop sleep must not pile a day's runs into one hour.
 */
export async function recordCiRuns(
  db: Driver,
  teamId: string,
  seat: string,
  runs: CiRunSample[],
): Promise<number> {
  if (runs.length === 0) return 0;
  const ids = runs.map((r) => r.run_id);
  const seen = new Set(
    (
      await db.all<{ target: string }>(
        `SELECT target FROM audit
          WHERE team_id = ? AND action = 'ci.run_measured'
            AND target IN (${ids.map(() => '?').join(',')})`,
        [teamId, ...ids],
      )
    ).map((r) => r.target),
  );
  let added = 0;
  for (const run of runs) {
    if (seen.has(run.run_id)) continue;
    seen.add(run.run_id);
    await appendAudit(db, teamId, {
      actor: seat,
      action: 'ci.run_measured',
      target: run.run_id,
      result: 'allow',
      detail: {
        created_at: run.created_at,
        head_sha: run.head_sha,
        branch: run.branch,
        event: run.event,
        attempt: run.attempt,
        conclusion: run.conclusion,
        duration_ms: run.duration_ms,
        jobs: run.jobs,
      },
    });
    added++;
  }
  return added;
}

interface Row {
  run_id: string;
  ts: number;
  d: Partial<CiRunSample>;
}

/** Nearest-rank percentile of an ascending array; the array is never empty here. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function isMain(d: Partial<CiRunSample>): boolean {
  return d.branch === 'main' && d.event !== 'pull_request';
}

/**
 * One window's shape. Flake: a PR SHA that was red and then green with no new commit — either a
 * later run on the same SHA succeeded after a failure, or a succeeding run carries `attempt > 1`.
 * A SHA that only ever failed is a real failure, not a flake; a SHA fixed by a new commit is a
 * different SHA. Cancelled runs are neither red nor green: a superseded push is not a signal.
 */
function windowOf(rows: Row[]): CiWindow {
  const main = rows.filter((r) => isMain(r.d) && typeof r.d.duration_ms === 'number');
  const mainDurations = main
    .filter((r) => r.d.conclusion === 'success' || r.d.conclusion === 'failure')
    .map((r) => r.d.duration_ms!)
    .sort((a, b) => a - b);
  const bySha = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.d.event !== 'pull_request' || typeof r.d.head_sha !== 'string') continue;
    const list = bySha.get(r.d.head_sha) ?? [];
    list.push(r);
    bySha.set(r.d.head_sha, list);
  }
  let flaky = 0;
  for (const runs of bySha.values()) {
    runs.sort((a, b) => a.ts - b.ts || a.run_id.localeCompare(b.run_id));
    let sawRed = false;
    let flake = false;
    for (const r of runs) {
      if (r.d.conclusion === 'failure') sawRed = true;
      else if (r.d.conclusion === 'success' && (sawRed || (r.d.attempt ?? 1) > 1)) flake = true;
    }
    if (flake) flaky++;
  }
  const jobs = new Map<string, number[]>();
  for (const r of rows)
    for (const j of r.d.jobs ?? []) {
      if (j.conclusion === 'skipped' || j.conclusion === 'cancelled') continue;
      const list = jobs.get(j.name) ?? [];
      list.push(j.duration_ms);
      jobs.set(j.name, list);
    }
  const jobRows = [...jobs]
    .map(([name, ds]) => {
      ds.sort((a, b) => a - b);
      return { name, runs: ds.length, p50_ms: nearestRank(ds, 0.5) };
    })
    .sort((a, b) => b.p50_ms - a.p50_ms || a.name.localeCompare(b.name))
    .slice(0, 8);
  return {
    main_runs: main.length,
    main_p50_ms: mainDurations.length > 0 ? nearestRank(mainDurations, 0.5) : null,
    main_p90_ms: mainDurations.length > 0 ? nearestRank(mainDurations, 0.9) : null,
    main_red: main.filter((r) => r.d.conclusion === 'failure').length,
    pr_shas: bySha.size,
    pr_flaky: flaky,
    jobs: jobRows,
  };
}

/** ADR 610: the last window beside the one before it. */
export async function deriveCiTrend(db: Driver, teamId: string, now: number): Promise<CiTrend> {
  const windowMs = CI_TREND_WINDOW_DAYS * DAY_MS;
  const since = now - 2 * windowMs;
  const rows: Row[] = [];
  for (const r of await db.all<{ target: string; ts: number; detail: string | null }>(
    `SELECT target, ts, detail FROM audit
        WHERE team_id = ? AND action = 'ci.run_measured' AND ts > ?`,
    [teamId, since],
  )) {
    try {
      const d = JSON.parse(r.detail ?? '{}') as Partial<CiRunSample>;
      // The run's own time; a row without one (never written by this store) falls back to the
      // ledger's stamp rather than being dropped.
      rows.push({
        run_id: r.target,
        ts: typeof d.created_at === 'number' ? d.created_at : r.ts,
        d,
      });
    } catch {
      /* a malformed row is skipped, never fatal */
    }
  }
  const split = now - windowMs;
  // Bucket by the run's own time. A row is sampled after its run completes, so `ts > since` on the
  // sampling clock is a superset of the runs that belong to the two windows; `created_at` decides.
  const inWindows = rows.filter((r) => r.ts > since);
  let newest: number | null = null;
  for (const r of rows) if (r.ts > (newest ?? -1)) newest = r.ts;
  return {
    window_days: CI_TREND_WINDOW_DAYS,
    current: windowOf(inWindows.filter((r) => r.ts > split)),
    previous: windowOf(inWindows.filter((r) => r.ts <= split)),
    sampled_through: newest,
  };
}
