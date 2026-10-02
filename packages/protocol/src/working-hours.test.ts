import { describe, expect, it } from 'vitest';
import {
  type WorkingDay,
  WorkingHoursSchema,
  isWithinWorkingHours,
  lastWorkingDayEnd,
  localDate,
  nightKey,
  workingDayStart,
} from './working-hours.js';

const reviveHours = {
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '11:00',
  end: '15:00',
};

describe('WorkingHoursSchema', () => {
  it('accepts a recurring Pacific weekday window', () => {
    expect(WorkingHoursSchema.parse(reviveHours)).toEqual(reviveHours);
  });

  it('accepts every supported weekday key', () => {
    expect(
      WorkingHoursSchema.parse({
        ...reviveHours,
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      }).days,
    ).toHaveLength(7);
  });

  it.each([
    ['empty days', { days: [] }],
    ['duplicate days', { days: ['mon', 'mon'] }],
    ['invalid day', { days: ['monday'] }],
    ['invalid start', { start: '9:00' }],
    ['invalid end', { end: '15:60' }],
    ['end before start', { start: '15:00', end: '11:00' }],
    ['invalid timezone', { timezone: 'Pacific/Definitely_Not_A_Timezone' }],
  ])('rejects %s', (_label, override) => {
    expect(() => WorkingHoursSchema.parse({ ...reviveHours, ...override })).toThrow();
  });
});

// ADR 494 §2: the daemon reads the schedule to withhold a dream during the day and to key a night
// by the date its working day ended. Every boundary is read in the schedule's own timezone.
describe('working-hours clock (ADR 494)', () => {
  const everyDay = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as WorkingDay[],
    start: '08:00',
    end: '22:30',
  };
  const weekdays = { ...everyDay, days: ['mon', 'tue', 'wed', 'thu', 'fri'] as WorkingDay[] };
  const at = (iso: string) => Date.parse(iso);

  it('is inside from start (inclusive) to end (exclusive), in the schedule timezone', () => {
    expect(isWithinWorkingHours(everyDay, at('2026-10-02T15:00:00Z'))).toBe(true); // 08:00 PDT
    expect(isWithinWorkingHours(everyDay, at('2026-10-02T14:59:00Z'))).toBe(false);
    expect(isWithinWorkingHours(everyDay, at('2026-10-02T05:29:00Z'))).toBe(true); // 22:29 PDT Oct 1
    expect(isWithinWorkingHours(everyDay, at('2026-10-02T05:30:00Z'))).toBe(false);
  });

  it('finds the end of the last working day and keys the night by its date', () => {
    const night = at('2026-10-02T10:00:00Z'); // 03:00 PDT Oct 2
    expect(lastWorkingDayEnd(everyDay, night)).toBe(at('2026-10-02T05:30:00Z'));
    expect(nightKey(everyDay, night)).toBe('2026-10-01');
  });

  it('makes a weekend one long night keyed by Friday', () => {
    const sundayNoon = at('2026-10-04T19:00:00Z');
    expect(isWithinWorkingHours(weekdays, sundayNoon)).toBe(false);
    expect(lastWorkingDayEnd(weekdays, sundayNoon)).toBe(at('2026-10-03T05:30:00Z'));
    expect(nightKey(weekdays, sundayNoon)).toBe('2026-10-02');
  });

  it('follows the daylight-saving change rather than a fixed offset', () => {
    // DST ends 2026-11-01: 22:30 that night is PST (UTC-8), not PDT.
    expect(lastWorkingDayEnd(everyDay, at('2026-11-02T10:00:00Z'))).toBe(
      at('2026-11-02T06:30:00Z'),
    );
  });

  it("gives today's start and local date only inside a working window", () => {
    const morning = at('2026-10-02T16:00:00Z'); // 09:00 PDT
    expect(workingDayStart(everyDay, morning)).toBe(at('2026-10-02T15:00:00Z'));
    expect(localDate('America/Los_Angeles', morning)).toBe('2026-10-02');
    expect(workingDayStart(everyDay, at('2026-10-02T10:00:00Z'))).toBeNull();
  });
});
