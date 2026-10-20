import { CALENDAR_DEFAULT_TZ, dayInZone, type MetricSource } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { dayDisputeRate, dayWakeLatency } from './insights.js';
import { getLane } from './lanes.js';
import { recordSample } from './laneSamples.js';

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

  const rows = await db.all<{ id: string; metric_json: string }>(
    `SELECT id, metric_json FROM lanes
      WHERE team_id = ? AND metric_json IS NOT NULL AND state NOT IN ('done','abandoned')`,
    [teamId],
  );
  const wanted: { id: string; source: DerivedSource }[] = [];
  for (const r of rows) {
    let source: unknown;
    try {
      source = (JSON.parse(r.metric_json) as { source?: unknown }).source;
    } catch {
      continue;
    }
    if (typeof source !== 'string' || source === 'manual') continue;
    if (isDerived(source)) wanted.push({ id: r.id, source });
    else if (!loggedUnknown.has(r.id)) {
      loggedUnknown.add(r.id);
      log.warn({ msg: 'metric_source_unknown', team: teamSlug, lane: r.id, source });
    }
  }
  if (wanted.length === 0) return [];

  // Each source is computed once per day, however many lanes name it.
  const values = new Map<DerivedSource, { value: number; n: number } | null>();
  const measure = async (source: DerivedSource) => {
    if (!values.has(source)) {
      if (source === 'wake_latency_p50_ms') {
        const w = await dayWakeLatency(db, teamId, since, until);
        values.set(source, w.p50_ms === null ? null : { value: w.p50_ms, n: w.n });
      } else {
        const d = await dayDisputeRate(db, teamId, since, until);
        values.set(source, d.rate === null ? null : { value: d.rate, n: d.n });
      }
    }
    return values.get(source) ?? null;
  };

  const out: SweptSample[] = [];
  for (const { id, source } of wanted) {
    const v = await measure(source);
    if (!v) continue;
    const lane = await getLane(db, teamId, id, teamSlug);
    if (!lane?.metric) continue;
    await recordSample(db, teamId, lane, { day, value: v.value, n: v.n }, by, now);
    out.push({ lane: id, source, day, value: v.value, n: v.n });
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
