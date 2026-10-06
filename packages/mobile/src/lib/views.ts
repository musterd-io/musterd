import {
  compareCalendarEntries,
  type CalendarEntry,
  type CalendarKind,
} from '@musterd/protocol/calendar';

/**
 * The calendar's views as pure reads (ADR 519 §Context: the artifact's Upcoming / Month / Past,
 * Picks / Everything, the kind filter, and "Up next"). No React and no device APIs here, so every
 * rule the screens rely on is unit-tested in Node.
 *
 * Dates stay wall-clock strings (`YYYY-MM-DD`, `HH:MM`) in the entry's own `tz`, exactly as stored.
 * The only clock read is `now`, passed in, and it is projected into a zone — never the other way.
 */

export type Scope = 'picks' | 'everything';

export interface Filter {
  scope: Scope;
  /** Kinds to show; empty means every kind. */
  kinds: readonly CalendarKind[];
}

export interface DaySection {
  date: string;
  entries: CalendarEntry[];
}

/** An entry with a start but no end counts as running this long, for "is it over yet". */
const OPEN_ENDED_MINUTES = 60;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The device's zone, as the runtime reports it. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `now` as wall-clock date and time in `tz`. */
export function wallClock(tz: string, now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** Whether an entry is behind us, read in the entry's own zone. An all-day entry lasts its day. */
export function isOver(entry: CalendarEntry, now: Date): boolean {
  const wc = wallClock(entry.tz, now);
  if (entry.date !== wc.date) return entry.date < wc.date;
  if (entry.start === null) return false;
  const until = entry.end === null ? minutes(entry.start) + OPEN_ENDED_MINUTES : minutes(entry.end);
  return until <= minutes(wc.time);
}

export function applyFilter(entries: readonly CalendarEntry[], filter: Filter): CalendarEntry[] {
  return entries.filter(
    (e) =>
      (filter.scope === 'everything' || e.pick) &&
      (filter.kinds.length === 0 || filter.kinds.includes(e.kind)),
  );
}

/** The next thing that is not over and not done — the line at the top of the screen. */
export function upNext(entries: readonly CalendarEntry[], now: Date): CalendarEntry | null {
  return (
    entries.filter((e) => e.status !== 'done' && !isOver(e, now)).sort(compareCalendarEntries)[0] ??
    null
  );
}

function sections(entries: CalendarEntry[]): DaySection[] {
  const out: DaySection[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.date === e.date) last.entries.push(e);
    else out.push({ date: e.date, entries: [e] });
  }
  return out;
}

/** Today and later, soonest first, one section per day. */
export function upcomingSections(entries: readonly CalendarEntry[], today: string): DaySection[] {
  return sections(entries.filter((e) => e.date >= today).sort(compareCalendarEntries));
}

/** Before today, most recent day first; within a day, calendar order. */
export function pastSections(entries: readonly CalendarEntry[], today: string): DaySection[] {
  return sections(entries.filter((e) => e.date < today).sort(compareCalendarEntries)).reverse();
}

/** Entries on one day, in calendar order. */
export function entriesOn(entries: readonly CalendarEntry[], date: string): CalendarEntry[] {
  return entries.filter((e) => e.date === date).sort(compareCalendarEntries);
}

/** How many entries fall on each date — the month grid's dots. */
export function countByDate(entries: readonly CalendarEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.date, (m.get(e.date) ?? 0) + 1);
  return m;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoDate(year: number, month0: number, day: number): string {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

function parseDate(date: string): { y: number; m0: number; d: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m0: m - 1, d };
}

/** Day of week, 0 = Sunday, for a `YYYY-MM-DD`. */
export function weekday(date: string): number {
  const { y, m0, d } = parseDate(date);
  return new Date(Date.UTC(y, m0, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const { y, m0, d } = parseDate(date);
  const t = new Date(Date.UTC(y, m0, d + n));
  return isoDate(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/** The month a date sits in, shifted by `delta` months. */
export function shiftMonth(
  year: number,
  month0: number,
  delta: number,
): { year: number; month0: number } {
  const t = new Date(Date.UTC(year, month0 + delta, 1));
  return { year: t.getUTCFullYear(), month0: t.getUTCMonth() };
}

/** Sunday-first weeks covering the month; days outside it are `null`. */
export function monthGrid(year: number, month0: number): (string | null)[][] {
  const first = isoDate(year, month0, 1);
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: weekday(first) }, () => null);
  for (let d = 1; d <= days; d++) cells.push(isoDate(year, month0, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function monthTitle(year: number, month0: number): string {
  return `${MONTHS_LONG[month0]} ${year}`;
}

/** `Today`, `Tomorrow`, `Yesterday`, or `Mon 6 Oct` (with the year when it is not this one). */
export function dayHeading(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  const { y, m0, d } = parseDate(date);
  const year = y === parseDate(today).y ? '' : ` ${y}`;
  return `${WEEKDAYS[weekday(date)]} ${d} ${MONTHS[m0]}${year}`;
}

/** `14:30` → `2:30pm`, `12:00` → `12pm`. */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${pad(m)}${suffix}`;
}

/** `All day`, `2pm`, or `2pm–3:30pm`. */
export function timeLabel(entry: CalendarEntry): string {
  if (entry.start === null) return 'All day';
  return entry.end === null
    ? clock12(entry.start)
    : `${clock12(entry.start)}–${clock12(entry.end)}`;
}

/**
 * When an entry's zone is not the device's, say whose clock its times are on (ADR 519
 * Consequences: the app shows times in the entry's `tz` and says so when it differs).
 */
export function zoneNote(entry: CalendarEntry, deviceTz: string): string | null {
  if (entry.tz === deviceTz) return null;
  const city = entry.tz.split('/').pop()?.replace(/_/g, ' ') ?? entry.tz;
  return `${city} time`;
}
