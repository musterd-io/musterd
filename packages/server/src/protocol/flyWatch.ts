import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { getCursor } from '../store/cursors.js';
import { getMemberById } from '../store/members.js';
import { hasLivePresence } from '../store/presence.js';
import { listDirectedSince, listHostSeen, listResidency, liveLease } from '../store/residency.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { FlyApiError, flyMachinesClient, type FlyMachines } from './flyMachines.js';

/**
 * Scale-to-zero for cloud seats (ADR 816): the lease-minting daemon starts a mapped Fly seat
 * machine when a wake is due for a seat resident there, and stops it when the machine is proven
 * idle. The machine never starts or stops itself and holds no Fly token (rule 1/5); the daemon's
 * one app-scoped deploy token (rule 2) is spent from here and nowhere else.
 *
 * Wake-due is read, never minted: leases are claimed by the host at poll time, so this sweep only
 * decides "should the machine be running" from the same unread-directed cursor the wake derivation
 * reads — stopped and starting time therefore consumes no wake attempts (rule 4). All start/stop
 * bookkeeping that must survive is in audit rows; what lives in memory (start times, backoff,
 * first-observed-running) is safe to lose on a daemon restart — losing it only delays a stop.
 */

/** Machine states a start may be asked of. Anything else (started, destroying, failed…) is left. */
const STARTABLE = new Set(['stopped', 'suspended']);
/** ADR 816 rule 6: start attempts per machine per rolling hour, before the sweep stops asking. */
export const FLY_MAX_STARTS_PER_HOUR = 6;
/** ADR 816 rule 6: failure backoff doublings are capped here. */
const START_BACKOFF_CAP_MS = 30 * 60_000;

interface StartRecord {
  startedAt: number;
  attempts: number[];
  nextOkAt: number;
}

export interface FlyWatchState {
  /** app/machine → start bookkeeping for starts THIS daemon process made or attempted. */
  starts: Map<string, StartRecord>;
  /** app/machine → when this process first observed the machine `started` (the idle clock's floor). */
  runningSince: Map<string, number>;
}

export function newFlyWatchState(): FlyWatchState {
  return { starts: new Map(), runningSince: new Map() };
}

export interface FlyWatchDeps {
  fly: FlyMachines;
  state: FlyWatchState;
}

const keyOf = (app: string, machine: string) => `${app}/${machine}`;

/** ADR 792's stop exemption: a shift row still on or ending from the last 36 h. The day key is the
 * schedule's, which this sweep does not resolve — a slightly stale row exempts a stop, the safe
 * direction (the cost of a wrong exemption is runtime, never a lost act). */
async function seatOnShift(
  ctx: Ctx,
  teamId: string,
  memberId: string,
  now: number,
): Promise<boolean> {
  const row = await ctx.db.get<{ one: number }>(
    `SELECT 1 AS one FROM shifts WHERE team_id = ? AND member_id = ? AND state IN ('on', 'ending') AND started_at > ? LIMIT 1`,
    [teamId, memberId, now - 36 * 60 * 60_000],
  );
  return row !== undefined;
}

/**
 * Directed acts this daemon can still call undelivered: newer than BOTH the seat's read cursor
 * and its last wake activity. The wake derivation's own read is the cursor alone (ADR 735) — but
 * a hub-mode seat reads its inbox on its joiner daemon, whose cursor never reaches the hub
 * (measured 2026-11-06 on delta-2: no `inbox_cursors` row on the hub at all), so a cursor-only
 * read counts every historical act forever and the stop rule can never fire. An act older than
 * the seat's last wake was in front of that wake; treating it as handled for start/stop purposes
 * costs at most a cold start when the next act lands. Actual leasing keeps its own cursor logic
 * on the polling daemon — this predicate only decides whether the machine should be running.
 */
async function unreadDirected(
  ctx: Ctx,
  member: MemberRow,
  enrolledAt: number,
  lastActivity: number | null,
): Promise<number> {
  const cursor = await getCursor(ctx.db, member.id);
  const since = Math.max(cursor.last_read_ts, lastActivity ?? 0);
  const rows = await listDirectedSince(ctx.db, member, since, enrolledAt);
  return rows.length;
}

/** Newest wake activity across seats (claim or completion), or null when there has never been any. */
async function lastWakeActivity(
  ctx: Ctx,
  teamId: string,
  seatNames: string[],
): Promise<number | null> {
  if (seatNames.length === 0) return null;
  const marks = seatNames.map(() => '?').join(', ');
  const row = await ctx.db.get<{ ts: number | null }>(
    `SELECT MAX(ts) AS ts FROM audit WHERE team_id = ? AND action IN ('residency.wake_leased', 'residency.woke', 'residency.wake_failed') AND target IN (${marks})`,
    [teamId, ...seatNames],
  );
  return row?.ts ?? null;
}

async function auditFly(
  ctx: Ctx,
  team: TeamRow,
  action: 'fly.machine_start' | 'fly.machine_stop',
  ok: boolean,
  detail: Record<string, unknown>,
  seat: string | null,
): Promise<void> {
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action,
    target: seat,
    result: ok ? 'allow' : 'deny',
    detail,
  });
}

async function sweepHost(
  ctx: Ctx,
  team: TeamRow,
  label: string,
  ref: { app: string; machine: string },
  deps: FlyWatchDeps,
  now: number,
): Promise<number> {
  const key = keyOf(ref.app, ref.machine);
  const rows = (await listResidency(ctx.db, team.id)).filter((r) => r.host === label);
  if (rows.length === 0) return 0;
  const seats: { member: MemberRow; enrolledAt: number }[] = [];
  for (const row of rows) {
    const member = await getMemberById(ctx.db, row.member_id);
    if (member) seats.push({ member, enrolledAt: row.updated_at });
  }
  if (seats.length === 0) return 0;

  let machineState: string | null;
  try {
    machineState = await deps.fly.machineState(ref.app, ref.machine);
  } catch (err) {
    log.warn({
      msg: 'fly_watch_state_failed',
      app: ref.app,
      machine: ref.machine,
      err: String(err),
    });
    return 0;
  }
  if (machineState === null) {
    log.warn({ msg: 'fly_watch_machine_unknown', app: ref.app, machine: ref.machine });
    return 0;
  }

  const hostSeenAt = (await listHostSeen(ctx.db, team.id)).get(label);
  const base = { app: ref.app, machine: ref.machine, host: label };

  if (STARTABLE.has(machineState)) {
    deps.state.runningSince.delete(key);
    let due: { member: MemberRow; enrolledAt: number } | undefined;
    for (const seat of seats) {
      if (await hasLivePresence(ctx.db, seat.member.id, ctx.config.presenceTimeoutMs)) continue;
      if (
        (await unreadDirected(
          ctx,
          seat.member,
          seat.enrolledAt,
          await lastWakeActivity(ctx, team.id, [seat.member.name]),
        )) > 0 ||
        (await seatOnShift(ctx, team.id, seat.member.id, now))
      ) {
        due = seat;
        break;
      }
    }
    if (!due) return 0;
    const rec = deps.state.starts.get(key) ?? { startedAt: 0, attempts: [], nextOkAt: 0 };
    rec.attempts = rec.attempts.filter((t) => now - t < 60 * 60_000);
    deps.state.starts.set(key, rec);
    if (now < rec.nextOkAt || rec.attempts.length >= FLY_MAX_STARTS_PER_HOUR) {
      log.warn({
        msg: 'fly_watch_start_bounded',
        ...base,
        attempts: rec.attempts.length,
        nextOkAt: rec.nextOkAt,
      });
      return 0;
    }
    rec.attempts.push(now);
    try {
      await deps.fly.startMachine(ref.app, ref.machine);
    } catch (err) {
      const status = err instanceof FlyApiError ? err.status : 0;
      const fails = rec.attempts.length;
      rec.nextOkAt = now + Math.min(60_000 * 2 ** (fails - 1), START_BACKOFF_CAP_MS);
      await auditFly(
        ctx,
        team,
        'fly.machine_start',
        false,
        { ...base, seat: due.member.name, status },
        due.member.name,
      );
      return 0;
    }
    rec.startedAt = now;
    rec.nextOkAt = 0;
    await auditFly(
      ctx,
      team,
      'fly.machine_start',
      true,
      { ...base, seat: due.member.name },
      due.member.name,
    );
    return 1;
  }

  if (machineState !== 'started') return 0;
  if (!deps.state.runningSince.has(key)) deps.state.runningSince.set(key, now);
  const startRec = deps.state.starts.get(key);
  const polledSinceStart =
    hostSeenAt !== undefined && (startRec?.startedAt ? hostSeenAt >= startRec.startedAt : true);

  const stop = async (reason: 'idle' | 'no_poll'): Promise<number> => {
    try {
      await deps.fly.stopMachine(ref.app, ref.machine);
    } catch (err) {
      const status = err instanceof FlyApiError ? err.status : 0;
      await auditFly(ctx, team, 'fly.machine_stop', false, { ...base, reason, status }, null);
      return 0;
    }
    deps.state.starts.delete(key);
    deps.state.runningSince.delete(key);
    await auditFly(ctx, team, 'fly.machine_stop', true, { ...base, reason }, null);
    return 1;
  };

  // ADR 816 rule 5, the ceiling: our start, no poll since — a boot or fold failure billing on.
  if (
    startRec?.startedAt &&
    !polledSinceStart &&
    now - startRec.startedAt >= ctx.config.flyNoPollStopMs
  ) {
    return stop('no_poll');
  }
  if (!polledSinceStart) return 0;

  for (const seat of seats) {
    if (await liveLease(ctx.db, seat.member.id, now)) return 0;
    if (await seatOnShift(ctx, team.id, seat.member.id, now)) return 0;
    if (
      (await unreadDirected(
        ctx,
        seat.member,
        seat.enrolledAt,
        await lastWakeActivity(ctx, team.id, [seat.member.name]),
      )) > 0
    )
      return 0;
  }
  const activity = await lastWakeActivity(
    ctx,
    team.id,
    seats.map((s) => s.member.name),
  );
  const idleBase = Math.max(activity ?? 0, deps.state.runningSince.get(key) ?? now);
  if (now - idleBase < ctx.config.flyIdleStopMs) return 0;
  return stop('idle');
}

/**
 * One sweep over every mapped machine. Returns the number of start/stop actions taken. Inert —
 * a fast 0 — unless the token and at least one mapping are configured (ADR 816 rule 2/3).
 */
export async function sweepFlyMachines(
  ctx: Ctx,
  now: number = Date.now(),
  deps?: FlyWatchDeps,
): Promise<number> {
  const token = ctx.config.flyApiToken;
  const mapped = Object.entries(ctx.config.flyMachines);
  if ((!token && !deps) || mapped.length === 0) return 0;
  const resolved: FlyWatchDeps = deps ?? {
    fly: flyMachinesClient(token!),
    state: newFlyWatchState(),
  };
  let actions = 0;
  for (const [slug, hosts] of mapped) {
    const team = await getTeamBySlug(ctx.db, slug);
    if (!team) continue;
    for (const [label, ref] of Object.entries(hosts)) {
      actions += await sweepHost(ctx, team, label, ref, resolved, now);
    }
  }
  return actions;
}

export function startFlyWatch(ctx: Ctx): () => void {
  if (!ctx.config.flyApiToken || Object.keys(ctx.config.flyMachines).length === 0) {
    return () => {};
  }
  const deps: FlyWatchDeps = {
    fly: flyMachinesClient(ctx.config.flyApiToken),
    state: newFlyWatchState(),
  };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepFlyMachines(ctx, Date.now(), deps);
    } catch (err) {
      log.warn({ msg: 'fly_watch_failed', err: String(err) });
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), ctx.config.flyWatchMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
