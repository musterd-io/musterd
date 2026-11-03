import {
  isWithinWorkingHours,
  makeEnvelope,
  type ShiftState,
  type ShiftStopReason,
  type WorkingHours,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { boardSeat } from '../store/boardSeat.js';
import { LaneConflictError, listLanes, updateLane } from '../store/lanes.js';
import { getMemberById, getMemberByName } from '../store/members.js';
import { waitingSeats } from '../store/questions.js';
import {
  effectiveWakePolicy,
  getResidency,
  listResidency,
  listResidencyTeamIds,
  liveLease,
  seatWakeDefaults,
} from '../store/residency.js';
import { parseWorkingHours, type MemberRow, type TeamRow } from '../store/rows.js';
import {
  budgetRaisedUsd,
  getShift,
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
import {
  pickAutoClaim,
  recommendationQuestion,
  recommendationThisShift,
  recommendFor,
} from '../store/shiftRecommend.js';
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
  now: number = Date.now(),
): Promise<{
  budgetUsd: number;
  basePolicyBudgetUsd: number;
  hours: WorkingHours | null;
  autonomy: 'ask' | 'claim' | 'free';
  autonomyGoals: string[] | undefined;
  shiftStart: 'manual' | 'auto';
}> {
  const teamRow = await getTeamById(ctx.db, team.id);
  const policy = effectiveWakePolicy(
    seatWakeDefaults(await getPolicy(ctx.db, team.id), member),
    (await getResidency(ctx.db, team.id, member.id))?.policy ?? null,
  );
  const hours = shiftHours(member, parseWorkingHours(teamRow?.working_hours));
  return {
    // ADR 795: the day's budget is the policy's plus what a person added for today.
    budgetUsd:
      policy.shift_budget_usd +
      (await budgetRaisedUsd(ctx.db, team.id, member.name, shiftDay(hours, now))),
    basePolicyBudgetUsd: policy.shift_budget_usd,
    hours,
    autonomy: policy.autonomy,
    autonomyGoals: policy.autonomy_goals,
    shiftStart: policy.shift_start,
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
    const { hours, basePolicyBudgetUsd } = await seatShiftPolicy(ctx, team, seat, now);
    const today = await getShift(ctx.db, team.id, seat.id, shiftDay(hours, now));
    // ADR 795: a Start after a `budget` stop does not run on the spent budget — it asks.
    if (today?.stop_reason === 'budget') {
      await askBudgetRaise(ctx, team, person, seat, today.day, basePolicyBudgetUsd, now);
      return;
    }
    await startShift(ctx.db, team.id, seat, person.name, hours, now);
  } else if (action === 'stop') {
    await stopAndAnnounce(ctx, team, seat, 'stopped', now, { stoppedBy: person.name });
  }
}

/**
 * ADR 795: today's budget is spent and a person pressed Start. The seat asks them, once a day, to
 * add one more day's budget for today; the answer is settled by {@link settleBudgetAsks}.
 */
async function askBudgetRaise(
  ctx: Ctx,
  team: TeamRow,
  person: MemberRow,
  seat: MemberRow,
  day: string,
  addUsd: number,
  now: number,
): Promise<void> {
  const open = await ctx.db.get<{ id: string }>(
    `SELECT id FROM audit WHERE team_id = ? AND action = 'shift.budget_asked' AND target = ?
       AND json_extract(detail, '$.day') = ? AND json_extract(detail, '$.settled') IS NULL
       AND NOT EXISTS (SELECT 1 FROM audit s WHERE s.team_id = audit.team_id
         AND s.action IN ('shift.budget_raised', 'shift.budget_declined')
         AND json_extract(s.detail, '$.question') = json_extract(audit.detail, '$.question'))`,
    [team.id, seat.name, day],
  );
  if (open) return;
  const id = ulid();
  const add = `$${addUsd.toFixed(2)}`;
  await routeEnvelope(
    ctx,
    team,
    seat,
    makeEnvelope({
      id,
      team: team.slug,
      from: seat.name,
      to: { kind: 'member', name: person.name },
      act: 'ask',
      body: `Today's budget is spent. Add ${add} for today so I can go back on shift?`,
      meta: {
        species: 'consult',
        question: {
          text: `Today's budget is spent. Add ${add} for today so I can go back on shift?`,
          why: 'You pressed Start after my shift stopped on its day budget.',
          options: [
            { label: `Yes, add ${add} for today`, consequence: 'I go back on shift now.' },
            { label: 'No, stay off shift', consequence: 'I stay off until tomorrow.' },
          ],
          blocking: false,
          audience: 'addressee',
          inferred: false,
        },
      },
      ts: now,
    }),
  );
  await appendAudit(ctx.db, team.id, {
    actor: person.name,
    action: 'shift.budget_asked',
    target: seat.name,
    result: 'allow',
    detail: { question: id, day, usd: addUsd },
  });
}

/**
 * ADR 795: an answered budget question — yes adds its amount to that day's budget and puts the seat
 * back on shift (if it is still that day); no, or any other answer, closes it. Each is settled once.
 */
export async function settleBudgetAsks(ctx: Ctx, now: number): Promise<number> {
  const asks = await ctx.db.all<{ team_id: string; target: string; detail: string }>(
    `SELECT team_id, target, detail FROM audit a WHERE action = 'shift.budget_asked' AND ts > ?
       AND NOT EXISTS (SELECT 1 FROM audit s WHERE s.team_id = a.team_id
         AND s.action IN ('shift.budget_raised', 'shift.budget_declined')
         AND json_extract(s.detail, '$.question') = json_extract(a.detail, '$.question'))`,
    [now - 2 * 24 * 60 * 60_000],
  );
  let raised = 0;
  for (const ask of asks) {
    const d = JSON.parse(ask.detail) as { question: string; day: string; usd: number };
    const answer = await ctx.db.get<{ meta: string | null; from_member: string }>(
      `SELECT meta, from_member FROM messages WHERE team_id = ? AND act = 'accept'
         AND json_extract(meta, '$.in_reply_to') = ? ORDER BY ts ASC LIMIT 1`,
      [ask.team_id, d.question],
    );
    if (!answer) continue;
    const choice = (JSON.parse(answer.meta ?? '{}') as { answer?: { choice?: number } }).answer
      ?.choice;
    const team = await getTeamById(ctx.db, ask.team_id);
    const person = await getMemberById(ctx.db, answer.from_member);
    const seat = team ? await getMemberByName(ctx.db, team.id, ask.target) : undefined;
    if (!team || !seat || person?.kind !== 'human' || choice !== 0) {
      await appendAudit(ctx.db, ask.team_id, {
        actor: person?.name ?? null,
        action: 'shift.budget_declined',
        target: ask.target,
        result: 'allow',
        detail: { question: d.question, day: d.day },
      });
      continue;
    }
    await appendAudit(ctx.db, team.id, {
      actor: person.name,
      action: 'shift.budget_raised',
      target: seat.name,
      result: 'allow',
      detail: { question: d.question, day: d.day, usd: d.usd },
    });
    const { hours } = await seatShiftPolicy(ctx, team, seat, now);
    if (shiftDay(hours, now) === d.day)
      await startShift(ctx.db, team.id, seat, person.name, hours, now);
    raised++;
  }
  return raised;
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
  await autoStartShifts(ctx, now);
  await settleBudgetAsks(ctx, now);
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
      if (await outOfWork(ctx, team, member, row, now)) stops++;
    }
  }
  return stops;
}

/**
 * ADR 793: an on-shift seat with nothing claimed. At `claim`/`free` it takes the best lane it may
 * (never a risky one); otherwise, once per shift, it asks a person which to take; with nothing to
 * offer, or once that recommendation was answered and it still holds nothing, it stops `no_work`.
 * Returns whether it stopped.
 */
async function outOfWork(
  ctx: Ctx,
  team: TeamRow,
  member: MemberRow,
  row: ShiftRow,
  now: number,
): Promise<boolean> {
  const { autonomy, autonomyGoals } = await seatShiftPolicy(ctx, team, member);
  const ranked = await recommendFor(ctx.db, team.id, team.slug, member.name);
  const pick = pickAutoClaim(ranked, autonomy, autonomyGoals);
  if (pick) {
    try {
      await updateLane(
        ctx.db,
        team.id,
        pick.id,
        team.slug,
        { owner_seat: member.name, state: 'claimed' },
        now,
        { owner_seat: null, state: 'open' },
        { actor: member.name },
      );
      await appendAudit(ctx.db, team.id, {
        actor: null,
        action: 'shift.claimed',
        target: member.name,
        result: 'allow',
        detail: { lane_id: pick.id, autonomy, shift_started_at: row.started_at },
      });
      return false;
    } catch (err) {
      // Someone took it between the read and the write: the next sweep picks again.
      if (err instanceof LaneConflictError) return false;
      throw err;
    }
  }
  const asked = await recommendationThisShift(ctx.db, team.id, member.name, row.started_at);
  // A person picked a lane: the answer wakes the seat to claim it. Give that wake its chance before
  // calling it no work (the host may not have polled yet).
  if (
    asked?.answer === 'picked' &&
    asked.answeredAt !== null &&
    now - asked.answeredAt < SHIFT_NO_WORK_GRACE_MS
  )
    return false;
  if (ranked.length === 0 || asked !== null)
    return (await stopAndAnnounce(ctx, team, member, 'no_work', now)) !== null;
  const q = recommendationQuestion(ranked);
  const id = ulid();
  await routeEnvelope(
    ctx,
    team,
    member,
    makeEnvelope({
      id,
      team: team.slug,
      from: member.name,
      to: { kind: 'team' },
      act: 'ask',
      body: q.text,
      meta: {
        species: 'consult',
        question: { ...q, blocking: false, audience: 'team', inferred: false },
      },
      ts: now,
    }),
  );
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action: 'shift.recommended',
    target: member.name,
    result: 'allow',
    detail: { question: id, lanes: ranked.map((l) => l.id), shift_started_at: row.started_at },
  });
  return false;
}

/**
 * ADR 793: `shift_start: auto` — an enrolled agent seat goes on shift on its own, once a day, the
 * first sweep inside its working hours. Never outside them, never a halted seat, and never on a day
 * it already has a row (a stopped shift stays stopped until a person's Start).
 */
export async function autoStartShifts(ctx: Ctx, now: number): Promise<number> {
  let started = 0;
  for (const teamId of await listResidencyTeamIds(ctx.db)) {
    const team = await getTeamById(ctx.db, teamId);
    if (!team) continue;
    for (const enrollment of await listResidency(ctx.db, teamId)) {
      const member = await getMemberById(ctx.db, enrollment.member_id);
      if (!member || member.kind !== 'agent' || member.left_at !== null) continue;
      if (member.halted_at !== null && member.halted_at !== undefined) continue;
      const { hours, shiftStart } = await seatShiftPolicy(ctx, team, member);
      if (shiftStart !== 'auto' || hours === null || !isWithinWorkingHours(hours, now)) continue;
      if (await getShift(ctx.db, teamId, member.id, shiftDay(hours, now))) continue;
      await startShift(ctx.db, teamId, member, 'auto', hours, now);
      started++;
    }
  }
  return started;
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
