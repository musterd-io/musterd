import type { Lane, LaneBoard } from '@musterd/protocol';

/**
 * The team's dated reads (ADR 644, spec 2026-10-17-experiments-panel-design.md): the lanes that
 * carry `reads_on`, grouped by the server's `read_status`. The web never derives a status from
 * dates — the board, the CLI and both routes have to agree at midnight — it only counts days for
 * the phrase ("overdue · 2 days"), against the same calendar zone the server derives on.
 */

export type ReadStatus = 'overdue' | 'due' | 'waiting' | 'read';

export interface ExperimentEntry {
  id: string;
  title: string;
  /** The title as the row shows it: the lane's name without the date it repeats or the
   *  instructions after its colon. The full title stays in `label`. */
  short: string;
  owner: string | null;
  status: ReadStatus;
  /** `YYYY-MM-DD`, as the lane carries it. */
  readsOn: string;
  /** Line 1: `overdue · 2 days`, `due today`, `in 16 days`, `met`. */
  phrase: string;
  /** Line 1, right: weekday plus `MM-DD` (`Mon 10-20`). */
  date: string;
  /** The calendar leaf: `TUE` over `20`, and `Oct` for a screen that wants the month. */
  leaf: { weekday: string; day: number; month: string };
  /** Days from today to `readsOn`: negative is past, 0 is today. Places the read on the fortnight strip. */
  offset: number;
  /** The verdict note, on a `read` entry only. */
  note: string | null;
  /** The whole row in words, for a screen reader. */
  label: string;
  /** What the read measures (experiment-results design §2), or null — then no chart, no number. */
  metric: ExperimentMetric | null;
  /** The daily samples the daemon serves with the lane (§3), oldest first; empty without a metric. */
  samples: readonly ExperimentSample[];
  /** The verdict's measured value (§5), on a `read` entry that carries one. */
  measured: { value: number; n: number } | null;
  /** The verdict's evidence pointer (§5), or null. */
  evidence: string | null;
}

/**
 * The shapes the experiment-results design adds to a lane (lanes `01M5B1YQVH`, `01M5B1ZM80`) —
 * declared structurally here until `@musterd/protocol` serves them, read off the lane defensively
 * so a daemon that predates them shows today's panel exactly.
 */
export interface ExperimentMetric {
  name: string;
  unit: string;
  baseline: number | null;
  target: number;
  direction: 'up' | 'down';
}
export interface ExperimentSample {
  day: string;
  value: number;
  n: number;
  /** ADR 701: today's point as it stands now, from `GET …/experiments/live` — not yet a day's row. */
  live?: boolean;
  /** When a live point was computed (ms). */
  asOf?: number;
}

/** ADR 701: one live point from `GET /teams/:slug/experiments/live`. */
export interface LiveSampleWire {
  lane: string;
  day: string;
  value: number;
  n: number;
  as_of: number;
}

/** `LIVE_SAMPLES_POLL_MS` from @musterd/protocol, restated for the same reason as the zone below. */
export const LIVE_POLL_MS = 30_000;

/** The live endpoint's body, read defensively (hard rule 4): a malformed row is dropped, not shown. */
export function readLiveSamples(json: unknown): LiveSampleWire[] {
  const rows = (json as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is LiveSampleWire =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as LiveSampleWire).lane === 'string' &&
      typeof (r as LiveSampleWire).day === 'string' &&
      isNum((r as LiveSampleWire).value) &&
      isNum((r as LiveSampleWire).n) &&
      isNum((r as LiveSampleWire).as_of),
  );
}


/**
 * ADR 701: put each metric entry's live point on its series — replacing today's stored sample when
 * there is one, appended after the history otherwise. Entries without a live point are unchanged.
 */
export function withLivePoints(
  entries: readonly ExperimentEntry[],
  live: readonly LiveSampleWire[],
): ExperimentEntry[] {
  if (live.length === 0) return [...entries];
  const byLane = new Map(live.map((l) => [l.lane, l]));
  return entries.map((e) => {
    const l = byLane.get(e.id);
    if (!l || !e.metric || e.status === 'read') return e;
    const point: ExperimentSample = { day: l.day, value: l.value, n: l.n, live: true, asOf: l.as_of };
    const history = e.samples.filter((s) => s.day !== l.day);
    return { ...e, samples: [...history, point] };
  });
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function metricOf(lane: unknown): ExperimentMetric | null {
  const m = (lane as { metric?: unknown }).metric;
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (typeof o['name'] !== 'string' || typeof o['unit'] !== 'string' || !isNum(o['target'])) return null;
  return {
    name: o['name'],
    unit: o['unit'],
    baseline: isNum(o['baseline']) ? o['baseline'] : null,
    target: o['target'],
    direction: o['direction'] === 'down' ? 'down' : 'up',
  };
}

function samplesOf(lane: unknown): ExperimentSample[] {
  const raw = (lane as { samples?: unknown }).samples;
  if (!Array.isArray(raw)) return [];
  const out: ExperimentSample[] = [];
  for (const r of raw) {
    const o = r as Record<string, unknown>;
    if (typeof o['day'] === 'string' && isNum(o['value'])) out.push({ day: o['day'], value: o['value'], n: isNum(o['n']) ? o['n'] : 0 });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

function measuredOf(lane: Lane): { value: number; n: number } | null {
  const m = (lane.read_verdict as { measured?: unknown } | undefined)?.measured;
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  return isNum(o['value']) ? { value: o['value'], n: isNum(o['n']) ? o['n'] : 0 } : null;
}

function evidenceOf(lane: Lane): string | null {
  const e = (lane.read_verdict as { evidence?: unknown } | undefined)?.evidence;
  return typeof e === 'string' && e.length > 0 ? e : null;
}

/** A value in its metric's unit: `%` to one decimal at most, `ms` whole, else two decimals at most. */
export function formatValue(value: number, unit: string): string {
  const u = unit.trim();
  if (u === '%') return `${trimZeros(value.toFixed(1))}%`;
  if (u === 'ms') return `${Math.round(value)} ms`;
  const body = Math.abs(value) >= 100 ? String(Math.round(value)) : trimZeros(value.toFixed(2));
  return u ? `${body} ${u}` : body;
}
const trimZeros = (s: string) => s.replace(/\.?0+$/, '');

/**
 * The result beside the word (§5): `met · 61% (target 40%, n 23)`. The word's meaning is unchanged —
 * the number is HOW, not WHETHER — so a read without `measured` keeps the word alone, as before.
 */
export function resultPhrase(e: Pick<ExperimentEntry, 'status' | 'phrase' | 'metric' | 'measured'>): string {
  if (e.status !== 'read' || !e.measured) return e.phrase;
  const unit = e.metric?.unit ?? '';
  const value = formatValue(e.measured.value, unit);
  const target = e.metric ? `target ${formatValue(e.metric.target, unit)}, ` : '';
  return `${e.phrase} · ${value} (${target}n ${e.measured.n})`;
}

/** The first sentence of a note — what the stream shows under a read row (§6). */
export function firstSentence(note: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(note.trim());
  return (m ? m[1]! : note.trim()).trim();
}

/** An evidence pointer that is a web address; a repo path or an ADR ref renders as text only. */
export function evidenceUrl(evidence: string | null): string | null {
  if (!evidence) return null;
  try {
    const u = new URL(evidence);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export const SPARK_W = 60;
export const SPARK_H = 16;

/**
 * The sparkline's geometry (§6), pure: the series as an SVG path, the baseline and target as y
 * positions, the latest value formatted. The y-range is the min and max of {baseline, target,
 * samples} with 10% headroom, so the target is always in frame. Null with no metric (a chart with no
 * metric is decoration) or no sample; one sample draws a dot and the number, no line.
 */
export function sparkline(
  metric: ExperimentMetric | null,
  samples: readonly ExperimentSample[],
  w = SPARK_W,
  h = SPARK_H,
): {
  path: string;
  targetY: number;
  baselineY: number | null;
  latest: string;
  /** ADR 701: where today's live point sits, when the series ends on one. */
  now: { x: number; y: number; asOf: number | null } | null;
  /** A lone sample that is not live: a still dot where the line would end. */
  lone: { x: number; y: number } | null;
  /** The soft fill under the line, down to the box's floor; '' with one sample. */
  area: string;
  /** Where the series ends, live or not: the dot every chart lands on. */
  end: { x: number; y: number };
  /** One sample: the first day of the series, so the number can say `day 1`. */
  firstDay: boolean;
} | null {
  // One sample still says something (nick, 2026-10-21: a newly charted experiment showed nothing on
  // its first day, not even the number): the number, and a dot at the right edge, where today sits —
  // `now` and the breathing dot when it is today's live point, a still dot when it is a past day.
  // No line: one point has no slope to draw.
  if (!metric || samples.length === 0) return null;
  const values = samples.map((s) => s.value);
  const all = [...values, metric.target, ...(metric.baseline === null ? [] : [metric.baseline])];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.1;
  lo -= pad;
  hi += pad;
  const y = (v: number) => +(h - ((v - lo) / (hi - lo)) * h).toFixed(2);
  const x = (i: number) =>
    samples.length === 1 ? w : +((i / (samples.length - 1)) * w).toFixed(2);
  const path =
    samples.length === 1 ? '' : values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(v)}`).join(' ');
  const last = samples[samples.length - 1]!;
  return {
    path,
    targetY: y(metric.target),
    baselineY: metric.baseline === null ? null : y(metric.baseline),
    latest: formatValue(values[values.length - 1]!, metric.unit),
    now: last.live
      ? { x: x(samples.length - 1), y: y(values[values.length - 1]!), asOf: last.asOf ?? null }
      : null,
    lone: samples.length === 1 && !last.live ? { x: w, y: y(values[0]!) } : null,
    area: samples.length === 1 ? '' : `${path} L${w} ${h} L0 ${h} Z`,
    end: { x: x(samples.length - 1), y: y(values[values.length - 1]!) },
    firstDay: samples.length === 1,
  };
}

/** `CALENDAR_DEFAULT_TZ` from @musterd/protocol, restated: a value import would pull zod onto the
 *  eager graph (spec §9). The server derives `read_status` in this zone; day counts use it too. */
const TEAM_TZ = 'America/Los_Angeles';
const DAY_MS = 86_400_000;
/** A `read` entry stays up this long after its verdict (spec §2). */
export const READ_SHOWN_MS = 7 * DAY_MS;
/** Rows before the cap; urgent rows are never hidden by it (spec §7). */
export const EXPERIMENTS_CAP = 5;

const GROUP: Record<ReadStatus, number> = { overdue: 0, due: 1, waiting: 2, read: 3 };

/** Today's `YYYY-MM-DD` in the team's calendar zone. */
export function teamToday(now: number): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TEAM_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const dayNumber = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / DAY_MS;
};

/** `Mon 10-20` and, for the row label, `Monday, October 20`. A calendar day has no zone: read in UTC. */
function dayLabels(ymd: string): { short: string; long: string; weekday: string; month: string } {
  const at = dayNumber(ymd) * DAY_MS;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(at);
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(at);
  const long = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
  return { short: `${weekday} ${ymd.slice(5)}`, long, weekday, month };
}

/** How many days ahead the fortnight strip reaches; a read further out sits at its far edge. */
export const STRIP_DAYS = 14;

/** The strip's days, today first: whether each falls on a weekend, which the strip shades. */
export function stripDays(now: number): { offset: number; weekend: boolean }[] {
  // Day 0 of the epoch was a Thursday, so (day + 4) % 7 is the weekday with Sunday as 0.
  const today = dayNumber(teamToday(now));
  return Array.from({ length: STRIP_DAYS + 1 }, (_, offset) => {
    const wd = (today + offset + 4) % 7;
    return { offset, weekend: wd === 0 || wd === 6 };
  });
}

/**
 * A lane title as a read's name. Lane titles carry their instructions ("ADR 536 14-day read
 * (2026-10-20): run `pnpm next:readout`…"), which a glance across a room cannot use. Keep what comes
 * before the first colon or dash, and drop a date in brackets, since the leaf already shows it. A
 * cut that leaves almost nothing keeps the whole title instead.
 */
export function shortTitle(title: string): string {
  const head = title.split(/:\s| — | – /)[0]!.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').trim();
  return head.length >= 8 ? head : title;
}

function phraseFor(status: ReadStatus, days: number, lane: Lane): string {
  switch (status) {
    case 'overdue': {
      // The status is the server's; a count that disagrees at midnight still says at least a day.
      const n = Math.max(1, days);
      return n === 1 ? 'overdue · 1 day' : `overdue · ${n} days`;
    }
    case 'due':
      return 'due today';
    case 'waiting': {
      const n = Math.max(1, -days);
      return n === 1 ? 'tomorrow' : `in ${n} days`;
    }
    case 'read':
      return lane.read_verdict?.outcome ?? 'read';
  }
}

/** Every entry the section shows, in group order (overdue, due, waiting, read) — uncapped. */
export function experimentEntries(board: LaneBoard | null, now: number): ExperimentEntry[] {
  if (!board) return [];
  const today = dayNumber(teamToday(now));
  const entries: { entry: ExperimentEntry; at: number }[] = [];
  for (const lane of board.lanes) {
    const status = lane.read_status;
    if (!lane.reads_on || !status || status === 'dropped') continue;
    const at = lane.read_verdict?.at ?? 0;
    if (status === 'read' && now - at > READ_SHOWN_MS) continue;
    const days = today - dayNumber(lane.reads_on);
    const phrase = phraseFor(status, days, lane);
    const date = dayLabels(lane.reads_on);
    const owner = lane.owner_seat ?? null;
    const note = status === 'read' ? (lane.read_verdict?.note ?? null) : null;
    const metric = metricOf(lane);
    const measured = status === 'read' ? measuredOf(lane) : null;
    entries.push({
      at,
      entry: {
        id: lane.id,
        title: lane.title,
        short: shortTitle(lane.title),
        owner,
        status,
        readsOn: lane.reads_on,
        phrase,
        date: date.short,
        leaf: { weekday: date.weekday.toUpperCase(), day: Number(lane.reads_on.slice(8)), month: date.month },
        offset: -days,
        note,
        metric,
        samples: metric ? samplesOf(lane) : [],
        measured,
        evidence: status === 'read' ? evidenceOf(lane) : null,
        label:
          `${lane.title}, ${phrase}` +
          (measured && metric
            ? `, measured ${formatValue(measured.value, metric.unit)} against ${formatValue(metric.target, metric.unit)}`
            : '') +
          `, reads ${date.long}${owner ? `, owner ${owner}` : ''}`,
      },
    });
  }
  return entries
    .sort((a, b) => {
      const g = GROUP[a.entry.status] - GROUP[b.entry.status];
      if (g !== 0) return g;
      switch (a.entry.status) {
        case 'overdue':
        case 'waiting':
          return a.entry.readsOn.localeCompare(b.entry.readsOn);
        case 'due':
          return a.entry.title.localeCompare(b.entry.title);
        case 'read':
          return b.at - a.at;
      }
    })
    .map((e) => e.entry);
}

const isUrgent = (e: ExperimentEntry) => e.status === 'overdue' || e.status === 'due';

/**
 * The instant a read day BEGINS in the team zone (00:00 America/Los_Angeles), in epoch ms — the
 * moment the server's `read_status` turns a `waiting` read into `due`, and what the countdown runs
 * toward (lane 01M5AXHFZT). Found by formatting the UTC-midnight guess back into the zone and
 * correcting by the difference, so DST falls out of Intl rather than a table.
 */
export function readDayStart(ymd: string, tz: string = TEAM_TZ): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(guess);
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const localAsUtc = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'));
  return guess - (localAsUtc - guess);
}

/** Whole days, hours and minutes in a span of ms (never negative; the caller keeps the sign). */
export function splitSpan(ms: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * The row's clock, read against `now` every minute (nick, 2026-10-19: "a countdown clock to make
 * it more exciting for the viewer"). The STATUS is still the server's — the clock only counts
 * toward or from the read day it names — so at the midnight seam the phrase can say `due today`
 * for a read the server still calls `waiting`, and the two agree within a tick.
 *   waiting  → `2d 14h 05m` · `14h 05m` · `05m`
 *   due      → `today · 9h 12m left`
 *   overdue  → `overdue · 2d 04h` · `overdue · 4h 12m`
 *   read     → the verdict word (unchanged)
 */
export function clockPhrase(
  e: Pick<ExperimentEntry, 'status' | 'readsOn' | 'phrase'> & Partial<Pick<ExperimentEntry, 'metric' | 'measured'>>,
  now: number,
): string {
  if (e.status === 'read') return resultPhrase({ status: e.status, phrase: e.phrase, metric: e.metric ?? null, measured: e.measured ?? null });
  const start = readDayStart(e.readsOn);
  if (e.status === 'waiting') {
    const ms = start - now;
    if (ms <= 0) return 'due today';
    const { days, hours, minutes } = splitSpan(ms);
    if (days >= 1) return `${days}d ${two(hours)}h ${two(minutes)}m`;
    if (hours >= 1) return `${hours}h ${two(minutes)}m`;
    return `${two(minutes)}m`;
  }
  if (e.status === 'due') {
    const left = start + DAY_MS - now;
    if (left <= 0) return 'due today';
    const { hours, minutes } = splitSpan(left);
    return `today · ${hours}h ${two(minutes)}m left`;
  }
  const { days, hours, minutes } = splitSpan(now - start);
  if (days >= 1) return `overdue · ${days}d ${two(hours)}h`;
  return `overdue · ${hours}h ${two(minutes)}m`;
}

/** The rows shown under the cap: every urgent row, then the rest up to `EXPERIMENTS_CAP`. */
export function capEntries(
  entries: readonly ExperimentEntry[],
  /** /broadcast: nobody can press "show all" on a stream, so a charted row (a metric with at least
   *  one sample) takes a free slot before an uncharted one. Urgent rows still come first, and the
   *  shown rows keep their group order. */
  preferCharted = false,
): ExperimentEntry[] {
  const urgent = entries.filter(isUrgent).length;
  const cap = Math.max(urgent, EXPERIMENTS_CAP);
  if (!preferCharted || entries.length <= cap) return entries.slice(0, cap);
  const charted = (e: ExperimentEntry) => e.metric !== null && e.samples.length > 0;
  const rank = (e: ExperimentEntry) => (isUrgent(e) ? 0 : charted(e) ? 1 : 2);
  const keep = new Set(
    entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
      .slice(0, cap)
      .map(({ e }) => e),
  );
  return entries.filter((e) => keep.has(e));
}

/** The head's count: the urgent statuses above 0, else the number of reads. */
export function experimentsCount(entries: readonly ExperimentEntry[]): string {
  const overdue = entries.filter((e) => e.status === 'overdue').length;
  const due = entries.filter((e) => e.status === 'due').length;
  const parts = [overdue > 0 && `${overdue} overdue`, due > 0 && `${due} due`].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');
  return entries.length === 1 ? '1 read' : `${entries.length} reads`;
}
