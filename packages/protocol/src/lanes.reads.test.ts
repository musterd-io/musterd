import { describe, expect, it } from 'vitest';
import {
  dayInZone,
  deriveReadStatus,
  LaneSchema,
  OpenLaneSchema,
  ReadVerdictInputSchema,
  UpdateLaneSchema,
} from './lanes.js';

const TZ = 'America/Los_Angeles';
// 2026-10-20 12:00 in Los Angeles (19:00 UTC).
const NOON_20 = Date.UTC(2026, 9, 20, 19, 0, 0);
const verdict = { outcome: 'met', note: 'read it', by: 'ryder', at: 1 };

describe('read dates on lanes (ADR 644)', () => {
  it('names today in the calendar zone, not in UTC', () => {
    // 02:00 UTC on the 21st is still the evening of the 20th in Los Angeles.
    expect(dayInZone(Date.UTC(2026, 9, 21, 2, 0, 0), TZ)).toBe('2026-10-20');
    expect(dayInZone(NOON_20, TZ)).toBe('2026-10-20');
  });

  it('derives waiting / due / overdue from today against reads_on', () => {
    const lane = (reads_on: string) => ({ reads_on, state: 'active' });
    expect(deriveReadStatus(lane('2026-10-21'), NOON_20, TZ)).toBe('waiting');
    expect(deriveReadStatus(lane('2026-10-20'), NOON_20, TZ)).toBe('due');
    expect(deriveReadStatus(lane('2026-10-19'), NOON_20, TZ)).toBe('overdue');
  });

  it('a verdict makes it read, even when the date has passed or the lane is abandoned', () => {
    expect(
      deriveReadStatus(
        { reads_on: '2026-10-01', read_verdict: verdict, state: 'done' },
        NOON_20,
        TZ,
      ),
    ).toBe('read');
    expect(
      deriveReadStatus(
        { reads_on: '2026-10-01', read_verdict: verdict, state: 'abandoned' },
        NOON_20,
        TZ,
      ),
    ).toBe('read');
  });

  it('an abandoned lane with no verdict is dropped, not overdue', () => {
    expect(deriveReadStatus({ reads_on: '2026-10-01', state: 'abandoned' }, NOON_20, TZ)).toBe(
      'dropped',
    );
  });

  it('a lane with no reads_on has no status', () => {
    expect(deriveReadStatus({ state: 'active' }, NOON_20, TZ)).toBeUndefined();
    expect(deriveReadStatus({ reads_on: null, state: 'active' }, NOON_20, TZ)).toBeUndefined();
  });

  it('reads_on must be a real day; null clears it on update only', () => {
    expect(OpenLaneSchema.safeParse({ title: 't', reads_on: '2026-02-30' }).success).toBe(false);
    expect(OpenLaneSchema.safeParse({ title: 't', reads_on: '2026-10-20' }).success).toBe(true);
    expect(OpenLaneSchema.safeParse({ title: 't', reads_on: null }).success).toBe(false);
    expect(UpdateLaneSchema.parse({ reads_on: null }).reads_on).toBeNull();
  });

  it('a verdict note is 1–280 characters, and a client cannot stamp by/at or read_status', () => {
    expect(ReadVerdictInputSchema.safeParse({ outcome: 'met', note: '' }).success).toBe(false);
    expect(
      ReadVerdictInputSchema.safeParse({ outcome: 'met', note: 'x'.repeat(281) }).success,
    ).toBe(false);
    expect(ReadVerdictInputSchema.safeParse({ outcome: 'later', note: 'x' }).success).toBe(false);
    const parsed = UpdateLaneSchema.parse({
      read_verdict: { outcome: 'missed', note: 'n', by: 'someone-else', at: 5 },
      read_status: 'read',
    });
    expect(parsed.read_verdict).toEqual({ outcome: 'missed', note: 'n' });
    expect(parsed).not.toHaveProperty('read_status');
  });

  it('a lane from a daemon behind ADR 644 still parses', () => {
    const behind = {
      id: '01X',
      team: 't',
      project: 'p',
      title: 'x',
      detail: '',
      owner_seat: null,
      role: null,
      scope: [],
      depends_on: [],
      branch: null,
      goal_id: null,
      risk: [],
      stakes: 'normal',
      state: 'open',
      created_by: 'nick',
      created_at: 1,
      claimed_at: null,
      resolved_at: null,
      updated_at: 1,
    };
    const lane = LaneSchema.parse(behind);
    expect(lane.reads_on).toBeUndefined();
    expect(lane.read_status).toBeUndefined();
  });
});
