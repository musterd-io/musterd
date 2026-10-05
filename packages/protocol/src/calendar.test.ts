import { describe, expect, it } from 'vitest';
import {
  CALENDAR_DEFAULT_TZ,
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  CalendarEntryInputSchema,
  CalendarEntrySchema,
  CalendarListSchema,
  CalendarWriteResponseSchema,
  compareCalendarEntries,
  type CalendarEntry,
} from './calendar.js';

const entry = (over: Partial<CalendarEntry> = {}): CalendarEntry =>
  CalendarEntrySchema.parse({
    id: '01M4728G4FEHNCJWTXDJVWF2KQ',
    title: 'SF Tech Week demo',
    date: '2026-10-08',
    start: '14:00',
    end: '14:30',
    tz: 'America/Los_Angeles',
    kind: 'demo',
    status: 'going',
    place: 'Mission Bay',
    url: 'https://example.com/demo',
    note: '',
    pick: true,
    source: '',
    source_ref: null,
    created_by: 'nick',
    created_at: 1,
    updated_at: 1,
    ...over,
  });

describe('calendar entries (ADR 519)', () => {
  it('carries the artifact’s eight kinds and six statuses, no more', () => {
    expect(CALENDAR_KINDS).toEqual([
      'demo',
      'topic',
      'pitch',
      'people',
      'prep',
      'deadline',
      'milestone',
      'event',
    ]);
    expect(CALENDAR_STATUSES).toEqual(['going', 'pending', 'list', 'invited', 'waitlist', 'done']);
  });

  it('an input fills its defaults: all-day, Pacific, no status, not a pick', () => {
    const parsed = CalendarEntryInputSchema.parse({
      title: '  Pitch practice ',
      date: '2026-10-09',
      kind: 'pitch',
    });
    expect(parsed).toEqual({
      title: 'Pitch practice',
      date: '2026-10-09',
      start: null,
      end: null,
      tz: CALENDAR_DEFAULT_TZ,
      kind: 'pitch',
      status: null,
      place: '',
      url: null,
      note: '',
      pick: false,
      source: '',
      source_ref: null,
    });
  });

  it('refuses a day that does not exist, a 24:00 time, and an end with no start', () => {
    const base = { title: 'x', kind: 'event' as const };
    expect(CalendarEntryInputSchema.safeParse({ ...base, date: '2026-02-30' }).success).toBe(false);
    expect(CalendarEntryInputSchema.safeParse({ ...base, date: '2026-10-9' }).success).toBe(false);
    expect(
      CalendarEntryInputSchema.safeParse({ ...base, date: '2026-10-09', start: '24:00' }).success,
    ).toBe(false);
    expect(
      CalendarEntryInputSchema.safeParse({ ...base, date: '2026-10-09', end: '10:00' }).success,
    ).toBe(false);
    expect(CalendarEntryInputSchema.safeParse({ ...base, date: '2028-02-29' }).success).toBe(true);
  });

  it('refuses an unknown zone, kind or status, an http link, and an over-long title', () => {
    const ok = { title: 'x', date: '2026-10-09', kind: 'event' };
    const bad = [
      { ...ok, tz: 'Pacific/Nowhere' },
      { ...ok, kind: 'party' },
      { ...ok, status: '' },
      { ...ok, url: 'http://example.com' },
      { ...ok, title: 'x'.repeat(161) },
      { ...ok, title: '   ' },
    ];
    for (const b of bad)
      expect(CalendarEntryInputSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(CalendarEntryInputSchema.safeParse({ ...ok, tz: 'Europe/London' }).success).toBe(true);
  });

  it('orders by date, all-day first, then start, then title, then id', () => {
    const a = entry({ id: 'a', date: '2026-10-09', start: '09:00' });
    const b = entry({ id: 'b', date: '2026-10-09', start: null, end: null });
    const c = entry({ id: 'c', date: '2026-10-08', start: '23:00' });
    const d = entry({ id: 'd', date: '2026-10-09', start: '09:00' });
    const e = entry({ id: 'e', date: '2026-10-09', start: '09:00', title: 'An earlier title' });
    expect([a, b, c, d, e].sort(compareCalendarEntries).map((x) => x.id)).toEqual([
      'c',
      'b',
      'e',
      'a',
      'd',
    ]);
  });

  it('the list and write envelopes round-trip', () => {
    const e = entry();
    expect(CalendarListSchema.parse({ entries: [e], deleted: ['x'], now: 5 })).toEqual({
      entries: [e],
      deleted: ['x'],
      now: 5,
    });
    expect(CalendarWriteResponseSchema.parse({ entry: e, outcome: 'unchanged' }).outcome).toBe(
      'unchanged',
    );
    expect(CalendarWriteResponseSchema.safeParse({ entry: e, outcome: 'merged' }).success).toBe(
      false,
    );
  });
});
