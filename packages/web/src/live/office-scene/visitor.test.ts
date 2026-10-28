import type { WorkingHours } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { createPet } from './pet';
import { dayMinute, startVisit, stepVisit, VISIT_GRACE_MIN, VISIT_MAX_S, visitDue, visitMinute } from './visitor';

const HOURS: WorkingHours = { timezone: 'America/Los_Angeles', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '11:00', end: '15:00' };

describe('when the dog comes by (lane 01M5XS6DP2)', () => {
  it('reads the day and minute in the team timezone', () => {
    // 2026-10-28 19:30 UTC is 12:30 in Los Angeles, a Wednesday.
    expect(dayMinute(new Date(Date.UTC(2026, 9, 28, 19, 30)), 'America/Los_Angeles')).toEqual({
      day: '2026-10-28',
      minute: 12 * 60 + 30,
      weekday: 'wed',
    });
  });

  it('picks one minute inside working hours, the same for everyone, different day to day', () => {
    const a = visitMinute('revive', '2026-10-28', 'wed', HOURS)!;
    expect(a).toBeGreaterThanOrEqual(11 * 60 + 15);
    expect(a).toBeLessThan(15 * 60 - 15);
    expect(visitMinute('revive', '2026-10-28', 'wed', HOURS)).toBe(a);
    const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map((d) =>
      visitMinute('revive', d, 'mon', HOURS),
    );
    expect(new Set(week).size).toBeGreaterThan(1);
  });

  it('never on a day off', () => {
    expect(visitMinute('revive', '2026-10-31', 'sat', HOURS)).toBeNull();
  });

  it('is due from its minute for the grace period, then not', () => {
    const at = visitMinute('revive', '2026-10-28', 'wed', HOURS)!;
    const utc = (min: number) => new Date(Date.UTC(2026, 9, 28, 7, 0) + min * 60_000); // 00:00 LA
    expect(visitDue('revive', utc(at - 1), HOURS)).toBeNull();
    expect(visitDue('revive', utc(at), HOURS)).toBe('2026-10-28');
    expect(visitDue('revive', utc(at + VISIT_GRACE_MIN), HOURS)).toBeNull();
  });
});

describe('the visit', () => {
  const seq = (() => {
    let x = 7;
    return () => ((x = (x * 16807) % 2147483647) / 2147483647);
  })();

  it('comes in, greets the office dog, wanders, and leaves through the door', () => {
    const resident = createPet(() => 0.5);
    const v = startVisit(resident, seq);
    const stages = new Set<string>([v.stage]);
    let woke = false;
    let guard = 0;
    while (stepVisit(v, resident, 0.05, seq) && guard++ < 10_000) {
      stages.add(v.stage);
      if (resident.mode !== 'sleep') woke = true;
    }
    expect(v.stage).toBe('done');
    expect([...stages]).toEqual(['greet', 'wander', 'leave']);
    expect(woke).toBe(true);
    expect(v.t).toBeLessThan(VISIT_MAX_S + 30);
  });

  it('goes home after VISIT_MAX_S, whatever it was doing', () => {
    const v = startVisit(null, seq);
    v.t = VISIT_MAX_S + 1;
    stepVisit(v, null, 0.05, seq);
    expect(v.stage).toBe('leave');
  });
});
