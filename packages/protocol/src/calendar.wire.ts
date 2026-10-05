/**
 * Calendar entries (ADR 519) without a validator — the closed kind and status sets, the entry shape,
 * and the one ordering every surface shares. `calendar.ts` builds the zod schemas from these, so a
 * reader that only renders (the phone's list, a future `/live` view) costs no zod.
 */

/** The artifact's eight kinds, carried over as they were on 2026-10-05. A new kind needs an ADR. */
export const CALENDAR_KINDS = [
  'demo',
  'topic',
  'pitch',
  'people',
  'prep',
  'deadline',
  'milestone',
  'event',
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/** The artifact's six statuses. An entry with no status carries `null`, never `''`. */
export const CALENDAR_STATUSES = [
  'going',
  'pending',
  'list',
  'invited',
  'waitlist',
  'done',
] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** Where an entry's wall-clock date and times are read, unless it says otherwise. */
export const CALENDAR_DEFAULT_TZ = 'America/Los_Angeles';

/** The shape `CalendarEntrySchema` parses to — declared here so the pure reads need no zod. */
export interface CalendarEntry {
  id: string;
  title: string;
  /** `YYYY-MM-DD`, wall-clock in `tz` — never converted to UTC. */
  date: string;
  /** `HH:MM` or null (an all-day entry). */
  start: string | null;
  /** `HH:MM` or null; null whenever `start` is. */
  end: string | null;
  /** IANA zone name the date and times are read in. */
  tz: string;
  kind: CalendarKind;
  status: CalendarStatus | null;
  place: string;
  /** An https link, or null. */
  url: string | null;
  note: string;
  /** Shown in the Picks view. */
  pick: boolean;
  /** Free text: where the entry came from. */
  source: string;
  /** The import's key (the artifact document id); null for an entry made in musterd. */
  source_ref: string | null;
  /** The Member who first wrote it. */
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** Calendar order (SPEC A.16): by date, all-day entries first, then start time, then title; id breaks a tie. */
export function compareCalendarEntries(a: CalendarEntry, b: CalendarEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const as = a.start ?? '';
  const bs = b.start ?? '';
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
