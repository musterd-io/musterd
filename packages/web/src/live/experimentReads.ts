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
        label: `${lane.title}, ${phrase}, reads ${date.long}${owner ? `, owner ${owner}` : ''}`,
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

/** The rows shown under the cap: every urgent row, then the rest up to `EXPERIMENTS_CAP`. */
export function capEntries(entries: readonly ExperimentEntry[]): ExperimentEntry[] {
  const urgent = entries.filter(isUrgent).length;
  return entries.slice(0, Math.max(urgent, EXPERIMENTS_CAP));
}

/** The head's count: the urgent statuses above 0, else the number of reads. */
export function experimentsCount(entries: readonly ExperimentEntry[]): string {
  const overdue = entries.filter((e) => e.status === 'overdue').length;
  const due = entries.filter((e) => e.status === 'due').length;
  const parts = [overdue > 0 && `${overdue} overdue`, due > 0 && `${due} due`].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');
  return entries.length === 1 ? '1 read' : `${entries.length} reads`;
}
