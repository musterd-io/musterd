import {
  CALENDAR_DEFAULT_TZ,
  dayInZone,
  LIVE_SAMPLES_POLL_MS,
  type LiveSample,
  type MetricSource,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { dayDisputeRate, dayWakeLatency } from './insights.js';
import { getLane } from './lanes.js';
import { recordSample, removeRecordedSample } from './laneSamples.js';

/**
 * ADR 673 §2, lane 2: the daemon's own samples. A metric lane whose `source` names a number the
 * daemon already derives gets yesterday's value written once a day, through the same store path
 * as `POST …/samples`, as the seat the caller names (the reaper passes the `digest` service seat). The day is the one `read_status` flips
 * on (`CALENDAR_DEFAULT_TZ`), so a lane's samples and its read day share one calendar. A day with
 * nothing to measure writes nothing: absence is not a zero (ADR 236).
 */

/** The sources this build derives. Anything else that is not `manual` is left alone. */
export const DERIVED_SOURCES = [
  'wake_latency_p50_ms',
  'dispute_rate',
] as const satisfies readonly MetricSource[];
type DerivedSource = (typeof DERIVED_SOURCES)[number];

/** How long after the zone's midnight the sweep waits, so yesterday is closed when it reads it. */
export const SAMPLE_SWEEP_DELAY_MS = 5 * 60 * 1000;

const isDerived = (s: string): s is DerivedSource =>
  (DERIVED_SOURCES as readonly string[]).includes(s);

/** Lanes whose unknown source was already logged, so a build that predates it says so once. */
const loggedUnknown = new Set<string>();

/** Midnight of `date` in `tz` as an instant. Two offset passes, like the working-hours clock. */
export function zoneMidnight(tz: string, date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y!, m! - 1, d!);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(guess);
    const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    guess +=
      wall - Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  }
  return guess;
}

/** `date` shifted by `days` calendar days. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** An open metric lane with a derived source: what the sweep and the live read both measure. */
interface DerivedLane {
  id: string;
  source: DerivedSource;
  harness: string | undefined;
}

async function derivedMetricLanes(
  db: Driver,
  teamId: string,
  teamSlug: string,
): Promise<DerivedLane[]> {
  const rows = await db.all<{ id: string; metric_json: string }>(
    `SELECT id, metric_json FROM lanes
      WHERE team_id = ? AND metric_json IS NOT NULL AND state NOT IN ('done','abandoned')`,
    [teamId],
  );
  const out: DerivedLane[] = [];
  for (const r of rows) {
    let metric: { source?: unknown; harness?: unknown };
    try {
      metric = JSON.parse(r.metric_json) as { source?: unknown; harness?: unknown };
    } catch {
      continue;
    }
    const source = metric.source;
    if (typeof source !== 'string' || source === 'manual') continue;
    const harness = typeof metric.harness === 'string' ? metric.harness : undefined;
    if (isDerived(source)) out.push({ id: r.id, source, harness });
    else if (!loggedUnknown.has(r.id)) {
      loggedUnknown.add(r.id);
      log.warn({ msg: 'metric_source_unknown', team: teamSlug, lane: r.id, source });
    }
  }
  return out;
}

/** Each source (and harness scope) is computed once per window, however many lanes name it. */
function derivedMeasurer(db: Driver, teamId: string, since: number, until: number) {
  const values = new Map<string, { value: number; n: number } | null>();
  return async (source: DerivedSource, harness: string | undefined) => {
    const key = `${source}|${harness ?? ''}`;
    if (!values.has(key)) {
      if (source === 'wake_latency_p50_ms') {
        const w = await dayWakeLatency(db, teamId, since, until, harness);
        values.set(key, w.p50_ms === null ? null : { value: w.p50_ms, n: w.n });
      } else {
        const d = await dayDisputeRate(db, teamId, since, until);
        values.set(key, d.rate === null ? null : { value: d.rate, n: d.n });
      }
    }
    return values.get(key) ?? null;
  };
}

/** What one sweep wrote, for the caller's log. */
export interface SweptSample {
  lane: string;
  source: DerivedSource;
  day: string;
  value: number;
  n: number;
}

/**
 * Write `day`'s sample for every open metric lane on the team with a derived source. Rerunning a
 * day replaces its rows (the store's upsert). `day` defaults to yesterday in the read-status zone;
 * a call before {@link SAMPLE_SWEEP_DELAY_MS} past midnight writes nothing.
 */
export async function sweepMetricSamples(
  db: Driver,
  teamId: string,
  teamSlug: string,
  now: number,
  by: string,
  day?: string,
): Promise<SweptSample[]> {
  const tz = CALENDAR_DEFAULT_TZ;
  const today = dayInZone(now, tz);
  if (day === undefined) {
    if (now < zoneMidnight(tz, today) + SAMPLE_SWEEP_DELAY_MS) return [];
    day = shiftDate(today, -1);
  }
  const since = zoneMidnight(tz, day);
  const until = zoneMidnight(tz, shiftDate(day, 1));

  const wanted = await derivedMetricLanes(db, teamId, teamSlug);
  if (wanted.length === 0) return [];
  const measure = derivedMeasurer(db, teamId, since, until);

  const out: SweptSample[] = [];
  for (const { id, source, harness } of wanted) {
    const v = await measure(source, harness);
    if (!v) continue;
    const lane = await getLane(db, teamId, id, teamSlug);
    if (!lane?.metric) continue;
    await recordSample(db, teamId, lane, { day, value: v.value, n: v.n }, by, now);
    out.push({ lane: id, source, day, value: v.value, n: v.n });
  }
  return out;
}

/** ADR 715: how many days back the daily pass re-checks the samples the daemon wrote. */
export const RECONCILE_DAYS = 30;

/** One day the reconcile pass changed. */
export interface ReconciledSample {
  lane: string;
  day: string;
  action: 'replaced' | 'removed';
}

/**
 * ADR 715: re-measure the days the daemon itself sampled (`by`) on each open derived lane, over the
 * last {@link RECONCILE_DAYS}, and make the stored row say what the lane's CURRENT scope measures.
 * A sample is written once, so a lane that later gained a harness filter (or a day answered after
 * it was written) kept a number its own definition no longer produces: the codex wake-latency
 * chart held the claude-code chart's points. A differing value is replaced; a day nothing now
 * measures is removed (`lane.sample_removed`), because absence is not a zero (ADR 236). Samples
 * written by anyone else — a seat's backfill, a manual point — are never touched.
 */
export async function reconcileDerivedSamples(
  db: Driver,
  teamId: string,
  teamSlug: string,
  now: number,
  by: string,
): Promise<ReconciledSample[]> {
  const tz = CALENDAR_DEFAULT_TZ;
  const today = dayInZone(now, tz);
  const oldest = shiftDate(today, -RECONCILE_DAYS);
  const out: ReconciledSample[] = [];
  for (const { id, source, harness } of await derivedMetricLanes(db, teamId, teamSlug)) {
    const rows = await db.all<{ day: string; value: number; n: number }>(
      `SELECT day, value, n FROM lane_samples
        WHERE team_id = ? AND lane_id = ? AND by_name = ? AND day >= ? AND day < ?
        ORDER BY day`,
      [teamId, id, by, oldest, today],
    );
    for (const row of rows) {
      const measure = derivedMeasurer(
        db,
        teamId,
        zoneMidnight(tz, row.day),
        zoneMidnight(tz, shiftDate(row.day, 1)),
      );
      const v = await measure(source, harness);
      if (!v) {
        await removeRecordedSample(db, teamId, id, row.day, by, now);
        out.push({ lane: id, day: row.day, action: 'removed' });
      } else if (v.value !== Number(row.value) || v.n !== Number(row.n)) {
        const lane = await getLane(db, teamId, id, teamSlug);
        if (!lane?.metric) continue;
        await recordSample(db, teamId, lane, { day: row.day, value: v.value, n: v.n }, by, now);
        out.push({ lane: id, day: row.day, action: 'replaced' });
      }
    }
  }
  return out;
}

/**
 * The reaper's once-a-day gate: the day each team was last swept for, so the loop's frequent ticks
 * run {@link sweepMetricSamples} once per team per day. `due` says whether a team is owed today's
 * sweep; `done` records it, only after the sweep succeeded, so a failed pass is retried on the next
 * tick. In memory: a restart sweeps the day once more, and the upsert makes that harmless.
 */
export function metricSampleGate(): {
  due: (teamId: string, now: number) => boolean;
  done: (teamId: string, now: number) => void;
} {
  const swept = new Map<string, string>();
  const tz = CALENDAR_DEFAULT_TZ;
  return {
    due: (teamId, now) => {
      const today = dayInZone(now, tz);
      return swept.get(teamId) !== today && now >= zoneMidnight(tz, today) + SAMPLE_SWEEP_DELAY_MS;
    },
    done: (teamId, now) => {
      swept.set(teamId, dayInZone(now, tz));
    },
  };
}

/** ADR 701: the daemon reuses a team's live points for this long, however many viewers ask. */
const liveCache = new Map<string, { at: number; samples: LiveSample[] }>();

/**
 * ADR 701: today's point for every open metric lane, as it stands now. A derived source is
 * measured over today so far (the zone's midnight to `now`), the same derivation the sweep writes
 * tomorrow for the whole day; a manual metric reads today's stored sample. Nothing is stored here.
 * A lane with nothing to measure yet today has no point: absence is not a zero (ADR 236).
 */
export async function liveMetricSamples(
  db: Driver,
  teamId: string,
  teamSlug: string,
  now: number = Date.now(),
): Promise<LiveSample[]> {
  const cached = liveCache.get(teamId);
  if (cached && now - cached.at < LIVE_SAMPLES_POLL_MS) return cached.samples;
  const today = dayInZone(now, CALENDAR_DEFAULT_TZ);
  const measure = derivedMeasurer(db, teamId, zoneMidnight(CALENDAR_DEFAULT_TZ, today), now);
  const samples: LiveSample[] = [];
  for (const { id, source, harness } of await derivedMetricLanes(db, teamId, teamSlug)) {
    const v = await measure(source, harness);
    if (v) samples.push({ lane: id, day: today, value: v.value, n: v.n, as_of: now });
  }
  const manual = await db.all<{ lane_id: string; value: number; n: number; at: number }>(
    `SELECT s.lane_id, s.value, s.n, s.at FROM lane_samples s
       JOIN lanes l ON l.id = s.lane_id AND l.team_id = s.team_id
      WHERE s.team_id = ? AND s.day = ? AND l.state NOT IN ('done','abandoned')
        AND json_extract(l.metric_json, '$.source') = 'manual'`,
    [teamId, today],
  );
  for (const m of manual) {
    samples.push({
      lane: m.lane_id,
      day: today,
      value: Number(m.value),
      n: Number(m.n),
      as_of: Number(m.at),
    });
  }
  liveCache.set(teamId, { at: now, samples });
  return samples;
}

/** A posted sample shows at once: the next live read recomputes this team's points. */
export function invalidateLiveSamples(teamId: string): void {
  liveCache.delete(teamId);
}

/** Tests only: forget cached live points. */
export function __clearLiveSamplesCache(): void {
  liveCache.clear();
}
