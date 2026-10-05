import { z } from 'zod';
import {
  CALENDAR_DEFAULT_TZ,
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  type CalendarEntry,
} from './calendar.wire.js';

/**
 * Calendar entries (ADR 519, SPEC A.16): the Team's calendar as team data — any active Member reads
 * it and writes it, and every write is one audit row. Dates and times are wall-clock in the entry's
 * `tz`, never converted to UTC, because "Thursday at noon" is what the calendar means.
 *
 * The zod face. The kind and status tuples, the entry shape and the ordering live in
 * `calendar.wire.ts`.
 */
export {
  CALENDAR_DEFAULT_TZ,
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  compareCalendarEntries,
  type CalendarEntry,
  type CalendarKind,
  type CalendarStatus,
} from './calendar.wire.js';

export const CalendarKindSchema = z.enum(CALENDAR_KINDS);
export const CalendarStatusSchema = z.enum(CALENDAR_STATUSES);

/** `YYYY-MM-DD` that names a real day — `2026-02-30` is refused, not rolled over. */
export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'date is not a real day');

/** `HH:MM`, 24-hour. */
export const CalendarTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (24-hour)');

/** An IANA zone name the runtime knows (`Intl` refuses an unknown one). */
export const CalendarTzSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'tz must be an IANA time zone name');

const HttpsUrlSchema = z
  .string()
  .max(2000)
  .url()
  .refine((u) => u.startsWith('https://'), 'url must be https');

export const CalendarEntrySchema: z.ZodType<CalendarEntry> = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(160),
  date: CalendarDateSchema,
  start: CalendarTimeSchema.nullable(),
  end: CalendarTimeSchema.nullable(),
  tz: CalendarTzSchema,
  kind: CalendarKindSchema,
  status: CalendarStatusSchema.nullable(),
  place: z.string().max(120),
  url: HttpsUrlSchema.nullable(),
  note: z.string().max(2000),
  pick: z.boolean(),
  source: z.string().max(120),
  source_ref: z.string().min(1).max(200).nullable(),
  created_by: z.string().min(1),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

/**
 * The body of `POST /teams/:slug/calendar` and `PUT /teams/:slug/calendar/:id` — what a writer
 * says; the daemon stamps `id`, `created_by` and the times. A PUT is a whole replacement, so an
 * omitted optional field reads as its default, not as "unchanged".
 */
export const CalendarEntryInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    date: CalendarDateSchema,
    start: CalendarTimeSchema.nullable().default(null),
    end: CalendarTimeSchema.nullable().default(null),
    tz: CalendarTzSchema.default(CALENDAR_DEFAULT_TZ),
    kind: CalendarKindSchema,
    status: CalendarStatusSchema.nullable().default(null),
    place: z.string().trim().max(120).default(''),
    url: HttpsUrlSchema.nullable().default(null),
    note: z.string().max(2000).default(''),
    pick: z.boolean().default(false),
    source: z.string().trim().max(120).default(''),
    source_ref: z.string().min(1).max(200).nullable().default(null),
  })
  .refine((e) => e.end === null || e.start !== null, {
    message: 'end needs a start',
    path: ['end'],
  });
export type CalendarEntryInput = z.infer<typeof CalendarEntryInputSchema>;

/**
 * `GET /teams/:slug/calendar[?since=<ms>]`. Without `since`: every entry, in calendar order. With
 * it: the entries written at or after `since`, and the ids deleted at or after it — a delta that
 * stays correct across deletes. `now` is the daemon's clock at the read; a poller passes it back as
 * the next `since`, so the phone's clock never enters the comparison.
 */
export const CalendarListSchema = z.object({
  entries: z.array(CalendarEntrySchema),
  deleted: z.array(z.string()),
  now: z.number().int(),
});
export type CalendarList = z.infer<typeof CalendarListSchema>;

/**
 * A write's answer. `unchanged` means the body matched what was stored, so nothing was written and
 * nothing was audited — the import's second run is all `unchanged` (ADR 519 §5).
 */
export const CalendarWriteOutcomeSchema = z.enum(['created', 'updated', 'unchanged']);
export type CalendarWriteOutcome = z.infer<typeof CalendarWriteOutcomeSchema>;

export const CalendarWriteResponseSchema = z.object({
  entry: CalendarEntrySchema,
  outcome: CalendarWriteOutcomeSchema,
});
export type CalendarWriteResponse = z.infer<typeof CalendarWriteResponseSchema>;

export const CalendarDeleteResponseSchema = z.object({ ok: z.literal(true) });
