import {
  isWithinWorkingHours,
  localDate,
  localDayStart,
  workingDayEndToday,
  type ShiftState,
  type ShiftStopReason,
  type WorkingHours,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';
import { MINTED_HERE } from './continuationStall.js';
import { parseWorkingHours, type MemberRow } from './rows.js';

/**
 * Seats on shift (ADR 792): one row per seat per day. Start opens it, Stop or a guardrail closes
 * it, and every surface reads the same {@link ShiftState} from here. The day's spend is never
 * stored — it is summed live from `residency.wake_cost` rows, so a cost reported after its lease
 * settled still counts on the next poll.
 */

export interface ShiftRow {
  team_id: string;
  member_id: string;
  day: string;
  state: 'on' | 'off' | 'ending';
  started_at: number;
  started_by: string;
  inside_hours: number;
  stopped_at: number | null;
  stop_reason: ShiftStopReason | null;
}

/** What an unpriced wake costs when the seat has no priced wake in the last 7 days. */
export const UNPRICED_WAKE_FALLBACK_USD = 0.5;
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The seat's schedule: its own working hours, else the team's, else none. */
export function shiftHours(
  member: Pick<MemberRow, 'working_hours'>,
  teamHours: WorkingHours | null,
): WorkingHours | null {
  return parseWorkingHours(member.working_hours) ?? teamHours;
}

/** The shift's calendar day: the date in the schedule's timezone (UTC with no schedule). */
export function shiftDay(hours: WorkingHours | null, now: number): string {
  return localDate(hours?.timezone ?? 'UTC', now);
}

export async function getShift(
  db: Driver,
  teamId: string,
  memberId: string,
  day: string,
): Promise<ShiftRow | null> {
  return (
    (await db.get<ShiftRow>(
      'SELECT * FROM shifts WHERE team_id = ? AND member_id = ? AND day = ?',
      [teamId, memberId, day],
    )) ?? null
  );
}

/** Open (or reopen) today's shift. `by` is a Member name, or `auto`. */
export async function startShift(
  db: Driver,
  teamId: string,
  member: MemberRow,
  by: string,
  hours: WorkingHours | null,
  now: number,
): Promise<ShiftRow> {
  const day = shiftDay(hours, now);
  const inside = hours !== null && isWithinWorkingHours(hours, now) ? 1 : 0;
  await db.run(
    `INSERT INTO shifts (team_id, member_id, day, state, started_at, started_by, inside_hours, stopped_at, stop_reason)
       VALUES (?, ?, ?, 'on', ?, ?, ?, NULL, NULL)
     ON CONFLICT (team_id, member_id, day) DO UPDATE SET state = 'on', started_at = excluded.started_at,
       started_by = excluded.started_by, inside_hours = excluded.inside_hours, stopped_at = NULL,
       stop_reason = NULL`,
    [teamId, member.id, day, now, by, inside],
  );
  await appendAudit(db, teamId, {
    actor: by === 'auto' ? null : by,
    action: 'shift.started',
    target: member.name,
    result: 'allow',
    detail: { by, inside_hours: inside === 1, day },
  });
  return (await getShift(db, teamId, member.id, day))!;
}

/**
 * Close today's shift with `reason`. While a wake still runs the row is `ending` and turns `off`
 * when it ends (`settleEnding`); nothing cancels the running wake. Null when no shift is on.
 */
export async function stopShift(
  db: Driver,
  teamId: string,
  member: MemberRow,
  reason: ShiftStopReason,
  hours: WorkingHours | null,
  now: number,
  opts: {
    leaseLive: boolean;
    actor?: string | null;
    detail?: Record<string, unknown>;
    /** The row's day, when it is not today's (a shift the watch finds past midnight). */
    day?: string;
  },
): Promise<ShiftRow | null> {
  const day = opts.day ?? shiftDay(hours, now);
  const r = await db.run(
    `UPDATE shifts SET state = ?, stopped_at = ?, stop_reason = ?
       WHERE team_id = ? AND member_id = ? AND day = ? AND state = 'on'`,
    [opts.leaseLive ? 'ending' : 'off', now, reason, teamId, member.id, day],
  );
  if (r.changes !== 1) return null;
  await appendAudit(db, teamId, {
    actor: opts.actor ?? null,
    action: 'shift.stopped',
    target: member.name,
    result: 'allow',
    detail: { reason, day, ending: opts.leaseLive, ...(opts.detail ?? {}) },
  });
  return getShift(db, teamId, member.id, day);
}

/** An `ending` shift whose wake has finished is `off`. */
export async function settleEnding(
  db: Driver,
  teamId: string,
  memberId: string,
  day: string,
): Promise<void> {
  await db.run(
    `UPDATE shifts SET state = 'off' WHERE team_id = ? AND member_id = ? AND day = ? AND state = 'ending'`,
    [teamId, memberId, day],
  );
}

/**
 * What the seat spent since `dayStart`: every wake leased here that was not deferred, at its
 * reported cost; a wake with no cost row yet counts as the seat's median priced wake of the last
 * seven days, else {@link UNPRICED_WAKE_FALLBACK_USD}. Read live on every poll.
 */
export async function shiftSpentUsd(
  db: Driver,
  teamId: string,
  seatName: string,
  dayStart: number,
  now: number,
): Promise<number> {
  const leased = await db.all<{ lease_id: string | null }>(
    `SELECT json_extract(detail, '$.lease_id') AS lease_id FROM audit
        WHERE team_id = ? AND action = 'residency.wake_leased' AND target = ? AND ts >= ? ${MINTED_HERE}`,
    [teamId, seatName, dayStart],
  );
  if (leased.length === 0) return 0;
  const deferred = new Set(
    (
      await db.all<{ lease_id: string | null }>(
        `SELECT json_extract(detail, '$.lease_id') AS lease_id FROM audit
            WHERE team_id = ? AND action = 'residency.wake_deferred' AND target = ? AND ts >= ?`,
        [teamId, seatName, dayStart],
      )
    ).map((r) => r.lease_id),
  );
  const spent = new Set(
    leased.map((r) => r.lease_id).filter((id): id is string => !!id && !deferred.has(id)),
  );
  const costs = await db.all<{ lease_id: string | null; cost: number | null; ts: number }>(
    `SELECT json_extract(detail, '$.lease_id') AS lease_id,
            json_extract(detail, '$.cost_usd') AS cost, ts FROM audit
        WHERE team_id = ? AND action = 'residency.wake_cost' AND target = ? AND ts >= ?`,
    [teamId, seatName, now - WEEK_MS],
  );
  let total = 0;
  const priced = new Set<string>();
  const week: number[] = [];
  for (const c of costs) {
    if (typeof c.cost !== 'number') continue;
    week.push(c.cost);
    if (c.lease_id && spent.has(c.lease_id)) {
      total += c.cost;
      priced.add(c.lease_id);
    }
  }
  const unpriced = [...spent].filter((id) => !priced.has(id)).length;
  return total + unpriced * medianOr(week, UNPRICED_WAKE_FALLBACK_USD);
}

function medianOr(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Is a stop due on this on-shift row? `hours_end` only for a shift started inside working hours
 * (a Start outside them is not ended by the clock); `budget` at or past the day's budget.
 */
export function shiftStopDue(
  row: Pick<ShiftRow, 'inside_hours'>,
  hours: WorkingHours | null,
  spentUsd: number,
  budgetUsd: number,
  now: number,
): 'hours_end' | 'budget' | null {
  if (row.inside_hours === 1 && hours !== null && !isWithinWorkingHours(hours, now))
    return 'hours_end';
  if (spentUsd >= budgetUsd) return 'budget';
  return null;
}

/** The day's start for the budget, in the schedule's timezone. */
export function shiftDayStart(hours: WorkingHours | null, now: number): number {
  return localDayStart(hours?.timezone ?? 'UTC', now);
}

/**
 * The seat's shift today as every surface reads it, or null: a human, or no row today. `until` is
 * today's hours end for a shift started inside them, else null.
 */
export async function shiftStateOf(
  db: Driver,
  teamId: string,
  member: MemberRow,
  hours: WorkingHours | null,
  budgetUsd: number,
  now: number,
): Promise<ShiftState | null> {
  if (member.kind === 'human') return null;
  const row = await getShift(db, teamId, member.id, shiftDay(hours, now));
  if (!row) return null;
  const spent = await shiftSpentUsd(db, teamId, member.name, shiftDayStart(hours, now), now);
  return {
    state: row.state,
    since: row.state === 'on' ? row.started_at : (row.stopped_at ?? row.started_at),
    until: row.inside_hours === 1 && hours !== null ? workingDayEndToday(hours, now) : null,
    budget_left_usd: Math.max(0, Math.round((budgetUsd - spent) * 100) / 100),
    stop_reason: row.stop_reason,
  };
}

/**
 * ADR 795: what a person added to this seat's budget for `day`, on a Start after a `budget` stop.
 * The day's budget is the policy's plus this; it never carries to another day.
 */
export async function budgetRaisedUsd(
  db: Driver,
  teamId: string,
  seat: string,
  day: string,
): Promise<number> {
  const rows = await db.all<{ usd: number | null }>(
    `SELECT json_extract(detail, '$.usd') AS usd FROM audit
       WHERE team_id = ? AND action = 'shift.budget_raised' AND target = ?
         AND json_extract(detail, '$.day') = ?`,
    [teamId, seat, day],
  );
  return rows.reduce((sum, r) => sum + (typeof r.usd === 'number' ? r.usd : 0), 0);
}
