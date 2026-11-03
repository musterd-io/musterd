import {
  makeEnvelope,
  type ShiftState,
  type ShiftStopReason,
  type WorkingHours,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { boardSeat } from '../store/boardSeat.js';
import { listLanes } from '../store/lanes.js';
import { getMemberById } from '../store/members.js';
import { waitingSeats } from '../store/questions.js';
import {
  effectiveWakePolicy,
  getResidency,
  liveLease,
  seatWakeDefaults,
} from '../store/residency.js';
import { parseWorkingHours, type MemberRow, type TeamRow } from '../store/rows.js';
import {
  settleEnding,
  shiftDay,
  shiftDayStart,
  shiftHours,
  shiftSpentUsd,
  shiftStateOf,
  shiftStopDue,
  startShift,
  stopShift,
  type ShiftRow,
} from '../store/shift.js';
import { getPolicy, getTeamById } from '../store/teams.js';
import { routeEnvelope } from './route.js';

/**
 * The shift watch (ADR 792): once a minute, every shift that is on or ending is checked against its
 * guardrails — hours, the day's budget, work left — and a stop is written with its reason and said
 * once by the board seat. The wake derivation refuses a shift wake whenever a stop is due, so this
 * loop decides nothing about wakes; it makes the stop visible, also when no host polls.
 */

export const SHIFT_WATCH_MS = 60_000;
/** A shift is not stopped for `no_work` until the Start's own wake had a chance to run. */
export const SHIFT_NO_WORK_GRACE_MS = 15 * 60_000;
const WORK_STATES = ['claimed', 'active'] as const;
const HELD_STATES = [
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'ready_for_review',
] as const;

/** The seat's effective shift knobs: team residency defaults ⊕ its enrollment override. */
export async function seatShiftPolicy(
  ctx: Ctx,
  team: { id: string },
  member: MemberRow,
): Promise<{ budgetUsd: number; hours: WorkingHours | null }> {
  const teamRow = await getTeamById(ctx.db, team.id);
  const policy = effectiveWakePolicy(
    seatWakeDefaults(await getPolicy(ctx.db, team.id), member),
    (await getResidency(ctx.db, team.id, member.id))?.policy ?? null,
  );
  return {
    budgetUsd: policy.shift_budget_usd,
    hours: shiftHours(member, parseWorkingHours(teamRow?.working_hours)),
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The board seat's one line for a stop (ADR 792 decision 4). */
export function shiftStopLine(input: {
  seat: string;
  reason: ShiftStopReason;
  claimed: number;
  blocked: number;
  budgetUsd: number;
  stoppedBy?: string;
  hoursEnd?: string;
}): string {
  const left =
    input.claimed > 0
      ? `${plural(input.claimed, 'lane')} still claimed`
      : input.blocked > 0
        ? `${plural(input.blocked, 'lane')} waiting on someone else`
        : 'nothing claimed';
  switch (input.reason) {
    case 'hours_end':
      return `${input.seat} is off shift: hours ended${input.hoursEnd ? ` at ${input.hoursEnd}` : ''}; ${left}.`;
    case 'budget':
      return `${input.seat} is off shift: today's $${input.budgetUsd.toFixed(2)} budget is spent; ${left}.`;
    case 'no_work':
      return `${input.seat} is off shift: no work left; ${left}.`;
    case 'stopped':
      return `${input.seat} is off shift: stopped${input.stoppedBy ? ` by ${input.stoppedBy}` : ''}; ${left}.`;
  }
}

async function laneCounts(
  ctx: Ctx,
  team: TeamRow,
  seat: string,
): Promise<{ claimed: number; blocked: number }> {
  const held = await listLanes(ctx.db, team.id, team.slug, {
    owner: seat,
    states: [...HELD_STATES],
  });
  const claimed = held.filter((l) => (WORK_STATES as readonly string[]).includes(l.state)).length;
  return { claimed, blocked: held.length - claimed };
}

/** Write the stop and say it once, as the board seat, to the team. Best-effort on the line. */
export async function stopAndAnnounce(
  ctx: Ctx,
  team: TeamRow,
  member: MemberRow,
  reason: ShiftStopReason,
  now: number,
  opts: { stoppedBy?: string; day?: string } = {},
): Promise<ShiftRow | null> {
  const { budgetUsd, hours } = await seatShiftPolicy(ctx, team, member);
  const counts = await laneCounts(ctx, team, member.name);
  const spent = await shiftSpentUsd(ctx.db, team.id, member.name, shiftDayStart(hours, now), now);
  const row = await stopShift(ctx.db, team.id, member, reason, hours, now, {
    leaseLive: (await liveLease(ctx.db, member.id, now)) !== null,
    actor: opts.stoppedBy ?? null,
    ...(opts.day ? { day: opts.day } : {}),
    detail: { lanes_claimed: counts.claimed, spent_usd: Math.round(spent * 100) / 100 },
  });
  if (!row) return null;
  const voice = await boardSeat(ctx.db, team);
  if (!voice) return row;
  const body = shiftStopLine({
    seat: member.name,
    reason,
    ...counts,
    budgetUsd,
    ...(opts.stoppedBy ? { stoppedBy: opts.stoppedBy } : {}),
    ...(reason === 'hours_end' && hours && !opts.day ? { hoursEnd: hours.end } : {}),
  });
  try {
    await routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'team' },
        act: 'status_update',
        body,
        meta: { shift_stop: { seat: member.name, reason } },
        ts: now,
      }),
    );
  } catch (err) {
    log.warn({
      msg: 'shift_stop_line_failed',
      team: team.slug,
      seat: member.name,
      err: String(err),
    });
  }
  return row;
}

/**
 * A person's Start or Stop quick action to an agent seat (ADR 792 decision 1), called after the
 * steer is stored. Start opens today's shift; Stop closes it with `stopped`.
 */
export async function applyShiftQuickAction(
  ctx: Ctx,
  team: TeamRow,
  person: MemberRow,
  seat: MemberRow,
  action: string,
  now: number,
): Promise<void> {
  if (person.kind !== 'human' || seat.kind !== 'agent') return;
  if (action === 'start') {
    const { hours } = await seatShiftPolicy(ctx, team, seat);
    await startShift(ctx.db, team.id, seat, person.name, hours, now);
  } else if (action === 'stop') {
    await stopAndAnnounce(ctx, team, seat, 'stopped', now, { stoppedBy: person.name });
  }
}

/** Is there work for an on-shift seat: a lane it owns that is claimed and not done? */
async function hasClaimedWork(ctx: Ctx, team: TeamRow, seat: string): Promise<boolean> {
  return (
    (await listLanes(ctx.db, team.id, team.slug, { owner: seat, states: [...WORK_STATES] }))
      .length > 0
  );
}

/** One pass over every live shift (ADR 792). Returns the stops it wrote. */
export async function sweepShifts(ctx: Ctx, now: number = Date.now()): Promise<number> {
  const rows = await ctx.db.all<ShiftRow>(
    "SELECT * FROM shifts WHERE state IN ('on', 'ending') ORDER BY team_id, member_id, day",
  );
  let stops = 0;
  const waiting = new Map<string, Set<string>>();
  for (const row of rows) {
    const team = await getTeamById(ctx.db, row.team_id);
    const member = await getMemberById(ctx.db, row.member_id);
    if (!team || !member) continue;
    const { budgetUsd, hours } = await seatShiftPolicy(ctx, team, member);
    const today = shiftDay(hours, now);
    const leaseLive = (await liveLease(ctx.db, member.id, now)) !== null;
    if (row.state === 'ending') {
      if (!leaseLive) await settleEnding(ctx.db, team.id, member.id, row.day);
      continue;
    }
    if (member.left_at !== null) {
      if (await stopAndAnnounce(ctx, team, member, 'stopped', now)) stops++;
      continue;
    }
    // A shift never outlives its day (from the commit security review: a carry-over would renew
    // itself every midnight on one person's Start, a day's budget at a time, with no end). It stops
    // and says so; a new day starts only with a new Start.
    if (row.day !== today) {
      if (await stopAndAnnounce(ctx, team, member, 'hours_end', now, { day: row.day })) stops++;
      continue;
    }
    const spent = await shiftSpentUsd(ctx.db, team.id, member.name, shiftDayStart(hours, now), now);
    const due = shiftStopDue(row, hours, spent, budgetUsd, now);
    if (due) {
      if (await stopAndAnnounce(ctx, team, member, due, now)) stops++;
      continue;
    }
    if (leaseLive || now - row.started_at < SHIFT_NO_WORK_GRACE_MS) continue;
    if (!waiting.has(team.id)) waiting.set(team.id, await waitingSeats(ctx.db, team.id));
    if (waiting.get(team.id)!.has(member.name)) continue;
    if (!(await hasClaimedWork(ctx, team, member.name))) {
      if (await stopAndAnnounce(ctx, team, member, 'no_work', now)) stops++;
    }
  }
  return stops;
}

export function startShiftWatch(ctx: Ctx): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepShifts(ctx);
    } catch (err) {
      log.warn({ msg: 'shift_watch_failed', err: String(err) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), SHIFT_WATCH_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/**
 * ADR 792: every agent seat's shift today, for the roster — the one value `/live`, `musterd status`
 * and `team_status` read. Only seats with a shift row in the last day and a half are read.
 */
export async function rosterShifts(
  ctx: Ctx,
  teamId: string,
  now: number,
): Promise<Map<string, ShiftState>> {
  const out = new Map<string, ShiftState>();
  const ids = await ctx.db.all<{ member_id: string }>(
    'SELECT DISTINCT member_id FROM shifts WHERE team_id = ? AND started_at > ?',
    [teamId, now - 36 * 60 * 60_000],
  );
  for (const { member_id } of ids) {
    const member = await getMemberById(ctx.db, member_id);
    if (!member || member.kind !== 'agent') continue;
    const { budgetUsd, hours } = await seatShiftPolicy(ctx, { id: teamId }, member);
    const state = await shiftStateOf(ctx.db, teamId, member, hours, budgetUsd, now);
    if (state) out.set(member_id, state);
  }
  return out;
}
