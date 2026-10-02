/**
 * Working hours (ADR 206) as plain TypeScript — no zod. `working-hours.ts` builds the schema from
 * these, so the day vocabulary and the clock/order rules have one home and the browser can read a
 * schedule without pulling a validator into its bundle (`guards.ts`).
 */

export const WORKING_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WorkingDay = (typeof WORKING_DAYS)[number];

/** A recurring schedule. `start`/`end` are `HH:mm` in `timezone`; `end` is later than `start`. */
export interface WorkingHours {
  timezone: string;
  days: WorkingDay[];
  start: string;
  end: string;
}

/** `HH:mm`, 24-hour. The single spelling of the clock format both readers check. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && CLOCK_TIME.test(value);
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** Days must be non-empty and duplicate-free — the rule both readers apply. */
export function isWorkingDayList(days: unknown): days is WorkingDay[] {
  if (!Array.isArray(days) || days.length === 0) return false;
  if (!days.every((d): d is WorkingDay => WORKING_DAYS.includes(d as WorkingDay))) return false;
  return new Set(days).size === days.length;
}

// ── The schedule as a clock (ADR 494) ───────────────────────────────────────────────────────────
// Pure Intl arithmetic, no dependency: every boundary is read in the schedule's own timezone, so a
// daylight-saving change moves the instant and never the local clock time.

interface LocalParts {
  date: string; // YYYY-MM-DD
  weekday: WorkingDay;
  minutes: number; // minutes since local midnight
}

function localParts(timezone: string, at: number): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    weekday: read('weekday').toLowerCase() as WorkingDay,
    minutes: (Number(read('hour')) % 24) * 60 + Number(read('minute')),
  };
}

function clockMinutes(value: string): number {
  const [hh, mm] = value.split(':').map(Number);
  return (hh ?? 0) * 60 + (mm ?? 0);
}

/** The instant a local wall-clock time occurs in `timezone` (two offset passes cover DST). */
function zonedInstant(timezone: string, date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, Math.floor(minutes / 60), minutes % 60);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const seen = localParts(timezone, guess);
    const [sy, sm, sd] = seen.date.split('-').map(Number);
    const seenWall = Date.UTC(sy!, sm! - 1, sd!, 0, seen.minutes);
    guess += wall - seenWall;
  }
  return guess;
}

/** `date` shifted by `days` calendar days (date-only arithmetic, no timezone involved). */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const WEEKDAY_BY_UTC_DAY: readonly WorkingDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function weekdayOf(date: string): WorkingDay {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY_BY_UTC_DAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/** The local calendar date (`YYYY-MM-DD`) of instant `at` in `timezone`. */
export function localDate(timezone: string, at: number): string {
  return localParts(timezone, at).date;
}

/** Is `at` inside the schedule? Right weekday and right clock, start inclusive, end exclusive. */
export function isWithinWorkingHours(hours: WorkingHours, at: number): boolean {
  const p = localParts(hours.timezone, at);
  if (!hours.days.includes(p.weekday)) return false;
  return p.minutes >= clockMinutes(hours.start) && p.minutes < clockMinutes(hours.end);
}

/**
 * The start instant of the working window `at` falls in, or null when `at` is outside working
 * hours. The morning digest keys off this: the first tick inside a window posts it.
 */
export function workingDayStart(hours: WorkingHours, at: number): number | null {
  if (!isWithinWorkingHours(hours, at)) return null;
  return zonedInstant(hours.timezone, localDate(hours.timezone, at), clockMinutes(hours.start));
}

/**
 * The instant the most recent working day ended at or before `at` (ADR 494 §2: a night runs from
 * one working day's end to the next one's start, so a weekend is one long night). Null only when
 * no working day ended in the last two weeks, which a valid schedule cannot produce.
 */
export function lastWorkingDayEnd(hours: WorkingHours, at: number): number | null {
  const today = localDate(hours.timezone, at);
  const end = clockMinutes(hours.end);
  for (let back = 0; back <= 14; back++) {
    const date = shiftDate(today, -back);
    if (!hours.days.includes(weekdayOf(date))) continue;
    const instant = zonedInstant(hours.timezone, date, end);
    if (instant <= at) return instant;
  }
  return null;
}

/** The key of the night `at` belongs to: the local date its working day ended (ADR 494 §2). */
export function nightKey(hours: WorkingHours, at: number): string | null {
  const ended = lastWorkingDayEnd(hours, at);
  return ended === null ? null : localDate(hours.timezone, ended);
}
