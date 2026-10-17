import {
  CALENDAR_DEFAULT_TZ,
  type Lane,
  type Pick,
  type PullAnnouncement,
  type PullPollResponse,
  dayInZone,
  makeEnvelope,
  pullEligible,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { routeEnvelope } from '../protocol/route.js';
import { appendAudit, appendLaneEventRequired } from './audit.js';
import { deriveGoalStatus, getLane, lanesForGoal, listLanes } from './lanes.js';
import {
  addMember,
  getMemberById,
  getMemberByName,
  listMembers,
  memberStandingRefusal,
} from './members.js';
import { listHostSeen, listResidency } from './residency.js';
import { type MemberRow, type TeamRow, parseRoles, resolveCapabilities } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * ADR 645 — the band-2 pull. A host with room polls (`offerPull`); the hub picks one eligible
 * (lane, seat) pair, has the host's service seat announce it to the lane's opener as an advisory
 * ask, and records the announcement. The hub alone watches the window (`sweepPullWindows`): a
 * steer or decline on the thread, a claim by anyone, or any change to the lane stops it; silence
 * grants it. The host then claims AS the seat, under the seat's own credential, with a
 * `pick {via: 'pull', ask}` — `assertPullGranted` is the claim-time check, `recordPullClaimed` the
 * record, `deliverPullWorkOrder` the directed work order that starts the seat (ADR 199 shape). A
 * pulled lane whose host died is released by `releaseDeadPulls`.
 *
 * The hub never acts as the seat (§4): no act here is sent from the seat; the announcement and the
 * work order are the host's service seat's, and the claim is the seat's own request.
 */

/** A grant the host has not redeemed within this is declined (`grant not redeemed`) and the lane
 *  is offered again. Long enough for a slow poll cycle plus a claim round-trip through a joiner. */
export const PULL_GRANT_TTL_MS = 15 * 60_000;

/** Service seats a host speaks as: `host-<label>`, label folded to the member-name alphabet. */
export function hostServiceSeatName(host: string): string {
  const folded = host
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `host-${folded || 'unnamed'}`;
}

/**
 * The host's own service seat (ADR 232), minted on first use. Null when the name is already held
 * by a seat that is not a live service seat — the host never speaks as somebody's agent or person.
 */
export async function hostServiceSeat(
  db: Driver,
  team: TeamRow,
  host: string,
): Promise<MemberRow | null> {
  const name = hostServiceSeatName(host);
  const existing = await getMemberByName(db, team.id, name);
  if (existing) return existing.kind === 'service' && existing.left_at === null ? existing : null;
  return (await addMember(db, team, { name, kind: 'service' })).row;
}

export interface PullAnnouncementRow {
  id: string;
  team_id: string;
  lane_id: string;
  member_id: string;
  host: string;
  ask_id: string;
  announced_by: string;
  tier: 'advisory' | 'standard';
  state: PullAnnouncement['state'];
  /** The lane's `updated_at` when announced — any later write to the lane stops the window (§4.2). */
  lane_updated_at: number;
  announced_at: number;
  window_ends_at: number;
  decided_at: number | null;
  reason: string | null;
}

async function toWire(db: Driver, row: PullAnnouncementRow): Promise<PullAnnouncement> {
  const seat = await getMemberById(db, row.member_id);
  return {
    id: row.id,
    lane: row.lane_id,
    seat: seat?.name ?? '?',
    host: row.host,
    ask: row.ask_id,
    announced_by: row.announced_by,
    tier: row.tier,
    state: row.state,
    announced_at: row.announced_at,
    window_ends_at: row.window_ends_at,
    decided_at: row.decided_at,
    reason: row.reason,
  };
}

export async function getPullAnnouncement(
  db: Driver,
  teamId: string,
  id: string,
): Promise<PullAnnouncementRow | null> {
  return (
    (await db.get<PullAnnouncementRow>(
      'SELECT * FROM pull_announcements WHERE team_id = ? AND id = ?',
      [teamId, id],
    )) ?? null
  );
}

/** The one announcement in flight for a host (§8: one pull in flight per host). */
async function inFlightForHost(
  db: Driver,
  teamId: string,
  host: string,
): Promise<PullAnnouncementRow | null> {
  return (
    (await db.get<PullAnnouncementRow>(
      `SELECT * FROM pull_announcements WHERE team_id = ? AND host = ?
         AND state IN ('announced', 'granted') ORDER BY announced_at DESC LIMIT 1`,
      [teamId, host],
    )) ?? null
  );
}

/** Offers a seat received since the start of today (team calendar zone), for the daily cap. */
async function offersToday(
  db: Driver,
  teamId: string,
  seatName: string,
  now: number,
): Promise<number> {
  const today = dayInZone(now, CALENDAR_DEFAULT_TZ);
  const rows = await db.all<{ ts: number }>(
    `SELECT ts FROM audit WHERE team_id = ? AND action = 'residency.pull_offered'
       AND json_extract(detail, '$.seat') = ? AND ts > ?`,
    [teamId, seatName, now - 2 * 86_400_000],
  );
  return rows.filter((r) => dayInZone(r.ts, CALENDAR_DEFAULT_TZ) === today).length;
}

/** When the seat last completed a wake, for the least-recently-woken tiebreak; 0 if never. */
async function lastWokeAt(db: Driver, teamId: string, seatName: string): Promise<number> {
  const row = await db.get<{ ts: number }>(
    `SELECT MAX(ts) AS ts FROM audit WHERE team_id = ? AND action = 'residency.woke' AND target = ?`,
    [teamId, seatName],
  );
  return row?.ts ?? 0;
}

/**
 * The opener, or the team's admin when the opener has left (§4.1). Null when neither can be
 * addressed — then nothing is announced and nothing is pulled.
 */
async function announcementAddressee(
  db: Driver,
  teamId: string,
  lane: Lane,
): Promise<MemberRow | null> {
  const opener = await getMemberByName(db, teamId, lane.created_by);
  if (opener && opener.left_at === null && opener.kind !== 'service') return opener;
  const admins = (await listMembers(db, teamId)).filter(
    (m) => m.left_at === null && m.kind === 'human' && resolveCapabilities(m).is_admin,
  );
  return admins[0] ?? null;
}

/**
 * The lanes a pull may offer today, in the ADR 536 order the hub ranks by: goal motion first
 * (a lane on an in-flight goal ahead of one on a planned goal or none), then age. Dependencies
 * must be met, as `rankUpNext` requires of anything claimable.
 */
async function eligibleLanes(db: Driver, team: TeamRow, now: number): Promise<Lane[]> {
  const today = dayInZone(now, CALENDAR_DEFAULT_TZ);
  const open = await listLanes(db, team.id, team.slug, { states: ['open'] });
  const candidates = open.filter((l) => pullEligible(l, today));
  const out: { lane: Lane; motion: number }[] = [];
  const goalMotion = new Map<string, number>();
  for (const lane of candidates) {
    let depsMet = true;
    for (const d of lane.depends_on) {
      const dep = await getLane(db, team.id, d, team.slug);
      if (dep && dep.state !== 'done') depsMet = false;
    }
    if (!depsMet) continue;
    let motion = 1;
    if (lane.goal_id !== null) {
      let m = goalMotion.get(lane.goal_id);
      if (m === undefined) {
        const status = deriveGoalStatus(await lanesForGoal(db, team.id, team.slug, lane.goal_id));
        m = status === 'in-flight' ? 0 : 1;
        goalMotion.set(lane.goal_id, m);
      }
      motion = m;
    }
    out.push({ lane, motion });
  }
  return out
    .sort((a, b) => a.motion - b.motion || a.lane.created_at - b.lane.created_at)
    .map((o) => o.lane);
}

/**
 * The host's band-2 poll (§4.3). Returns the announcement in flight for this host, a fresh one when
 * a (lane, seat) pair was found and announced, or null with the reason nothing was offered. Hub
 * only — a joiner forwards (`/sync/pull`).
 */
export async function offerPull(
  ctx: Ctx,
  team: TeamRow,
  host: string,
  now = Date.now(),
): Promise<PullPollResponse> {
  const db = ctx.db;
  const inFlight = await inFlightForHost(db, team.id, host);
  if (inFlight) return { offer: await toWire(db, inFlight) };
  const policy = (await getPolicy(db, team.id)).pull;

  // The seats enrolled here with room under the daily cap, in good standing.
  const seats: { member: MemberRow; roles: string[]; lastWoke: number }[] = [];
  for (const r of (await listResidency(db, team.id)).filter((r) => r.host === host)) {
    const member = await getMemberById(db, r.member_id);
    if (!member || member.kind === 'service' || memberStandingRefusal(member, now)) continue;
    if ((await offersToday(db, team.id, member.name, now)) >= policy.daily_cap_per_seat) continue;
    seats.push({
      member,
      roles: parseRoles(member),
      lastWoke: await lastWokeAt(db, team.id, member.name),
    });
  }
  if (seats.length === 0)
    return { offer: null, idle_reason: 'no enrolled seat with room on this host' };

  for (const lane of await eligibleLanes(db, team, now)) {
    const fit = seats
      .filter((s) => lane.role === null || s.roles.includes(lane.role))
      .sort((a, b) => a.lastWoke - b.lastWoke);
    const chosen = fit[0];
    if (!chosen) continue;
    const voice = await hostServiceSeat(db, team, host);
    if (!voice)
      return { offer: null, idle_reason: `"${hostServiceSeatName(host)}" is not a service seat` };
    const to = await announcementAddressee(db, team.id, lane);
    if (!to) return { offer: null, idle_reason: 'the opener has left and the team has no admin' };
    const tier =
      lane.pre_registered!.expected_spend > policy.spend_cap_usd ? 'standard' : 'advisory';
    const windowMs = tier === 'standard' ? policy.standard_window_ms : policy.window_ms;
    const id = ulid();
    const askId = ulid();
    const minutes = Math.round(windowMs / 60_000);
    const run = lane.pre_registered!.run;
    const body =
      `host ${host} proposes seat ${chosen.member.name} for lane ${lane.id} "${lane.title}" ` +
      `(pre-registered: ${run.length > 200 ? `${run.slice(0, 200)}…` : run}; ` +
      `expected spend $${lane.pre_registered!.expected_spend}). ` +
      `Answer in ${minutes} min to stop it — a steer or decline here, or any change to the lane, ` +
      `holds it; silence lets ${chosen.member.name} claim it (ADR 645).`;
    await routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: askId,
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: to.name },
        act: 'ask',
        body,
        meta: {
          species: 'consult',
          tier,
          pull: { announcement: id, lane: lane.id, seat: chosen.member.name, host },
        },
      }),
      undefined,
      true,
    );
    await db.run(
      `INSERT INTO pull_announcements
         (id, team_id, lane_id, member_id, host, ask_id, announced_by, tier, state, lane_updated_at,
          announced_at, window_ends_at, decided_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'announced', ?, ?, ?, NULL, NULL)`,
      [
        id,
        team.id,
        lane.id,
        chosen.member.id,
        host,
        askId,
        voice.name,
        tier,
        lane.updated_at,
        now,
        now + windowMs,
      ],
    );
    await appendAudit(db, team.id, {
      actor: null,
      action: 'residency.pull_offered',
      target: chosen.member.name,
      result: 'allow',
      detail: {
        lane: lane.id,
        seat: chosen.member.name,
        host,
        announcement: id,
        ask: askId,
        to: to.name,
        tier,
        window_ms: windowMs,
      },
    });
    return { offer: await toWire(db, (await getPullAnnouncement(db, team.id, id))!) };
  }
  return {
    offer: null,
    idle_reason: 'no eligible pre-registered lane for the seats enrolled here',
  };
}

/** A steer or decline on the announcement's thread, by whom — the human's "stop" (§4.2). */
async function objectionOn(db: Driver, teamId: string, askId: string): Promise<string | null> {
  const row = await db.get<{ act: string; from_member: string }>(
    `SELECT m.act, m.from_member FROM messages m
       WHERE m.team_id = ? AND m.act IN ('steer', 'decline')
         AND (m.thread_id = ? OR json_extract(m.meta, '$.in_reply_to') = ?)
       ORDER BY m.created_at ASC LIMIT 1`,
    [teamId, askId, askId],
  );
  if (!row) return null;
  const from = await getMemberById(db, row.from_member);
  return `${row.act} by ${from?.name ?? '?'}`;
}

/** Why the window must stop now, judged on the lane's CURRENT state (ADR 623), or null to grant. */
async function stopReason(
  db: Driver,
  team: TeamRow,
  row: PullAnnouncementRow,
): Promise<string | null> {
  const lane = await getLane(db, team.id, row.lane_id, team.slug);
  if (!lane) return 'lane gone';
  if (lane.owner_seat !== null) return `claimed by ${lane.owner_seat}`;
  if (lane.state !== 'open') return `lane is ${lane.state}`;
  if (!lane.pre_registered) return 'declaration withdrawn';
  if (lane.updated_at !== row.lane_updated_at) return 'lane changed during the window';
  const seat = await getMemberById(db, row.member_id);
  if (!seat || memberStandingRefusal(seat)) return `seat ${seat?.name ?? '?'} lost standing`;
  return await objectionOn(db, team.id, row.ask_id);
}

async function transition(
  db: Driver,
  row: PullAnnouncementRow,
  from: PullAnnouncement['state'],
  to: PullAnnouncement['state'],
  now: number,
  reason: string | null,
): Promise<boolean> {
  const res = await db.run(
    `UPDATE pull_announcements SET state = ?, decided_at = ?, reason = ?
       WHERE id = ? AND state = ?`,
    [to, now, reason, row.id, from],
  );
  return res.changes === 1;
}

async function declineAudit(db: Driver, row: PullAnnouncementRow, reason: string): Promise<void> {
  const seat = await getMemberById(db, row.member_id);
  await appendLaneEventRequired(db, row.team_id, {
    actor: null,
    action: 'lane.pull_declined',
    target: row.lane_id,
    result: 'allow',
    detail: {
      lane: row.lane_id,
      seat: seat?.name ?? '?',
      host: row.host,
      announcement: row.id,
      ask: row.ask_id,
      reason,
    },
  });
}

export interface PullWindowDecision {
  announcement: string;
  lane: string;
  decision: 'granted' | 'declined';
  reason: string | null;
}

/**
 * The hub's window watcher (§4.2, §6). Every `announced` row past its window is decided once:
 * stopped (`lane.pull_declined` with the reason) or granted. A `granted` row nobody redeemed in
 * {@link PULL_GRANT_TTL_MS} is declined too, so a dead host cannot hold an offer. The transition is
 * a guarded UPDATE: on Cloud the first server to move the row owns the decision.
 */
export async function sweepPullWindows(
  ctx: Ctx,
  team: TeamRow,
  now = Date.now(),
): Promise<PullWindowDecision[]> {
  const db = ctx.db;
  const out: PullWindowDecision[] = [];
  const due = await db.all<PullAnnouncementRow>(
    `SELECT * FROM pull_announcements WHERE team_id = ? AND state = 'announced' AND window_ends_at <= ?`,
    [team.id, now],
  );
  for (const row of due) {
    const reason = await stopReason(db, team, row);
    const to = reason ? 'declined' : 'granted';
    if (!(await transition(db, row, 'announced', to, now, reason))) continue;
    if (reason) await declineAudit(db, row, reason);
    out.push({ announcement: row.id, lane: row.lane_id, decision: to, reason });
  }
  const stale = await db.all<PullAnnouncementRow>(
    `SELECT * FROM pull_announcements WHERE team_id = ? AND state = 'granted' AND decided_at <= ?`,
    [team.id, now - PULL_GRANT_TTL_MS],
  );
  for (const row of stale) {
    const reason = 'grant not redeemed';
    if (!(await transition(db, row, 'granted', 'declined', now, reason))) continue;
    await declineAudit(db, row, reason);
    out.push({ announcement: row.id, lane: row.lane_id, decision: 'declined', reason });
  }
  return out;
}

/**
 * The claim-time check (§4.3): a `pick {via: 'pull'}` must name a `granted` announcement for this
 * very lane and seat. Throws `MusterdError` otherwise — the ordinary claim checks (standing,
 * residency, service seat) run beside it in `decideLanePatch`.
 */
export async function assertPullGranted(
  db: Driver,
  teamId: string,
  laneId: string,
  seat: { id: string; name: string },
  pick: Pick,
): Promise<PullAnnouncementRow> {
  if (!pick.ask)
    throw new MusterdError(
      'bad_request',
      'a pull claim names its announcement: pick.ask (ADR 645)',
    );
  const row = await db.get<PullAnnouncementRow>(
    'SELECT * FROM pull_announcements WHERE team_id = ? AND ask_id = ?',
    [teamId, pick.ask],
  );
  if (!row)
    throw new MusterdError('bad_request', `no pull announcement with ask ${pick.ask} (ADR 645)`);
  if (row.lane_id !== laneId || row.member_id !== seat.id)
    throw new MusterdError(
      'forbidden',
      `announcement ${row.id} proposed another (lane, seat) pair — a pull claim is only the ` +
        `one the hub granted (ADR 645)`,
    );
  if (row.state !== 'granted')
    throw new MusterdError(
      'conflict',
      row.state === 'announced'
        ? `the announcement window for lane "${laneId}" has not lapsed — the hub has not granted it`
        : `announcement ${row.id} is ${row.state}${row.reason ? ` (${row.reason})` : ''} — not claimable`,
    );
  if (pick.requested_by !== row.announced_by)
    throw new MusterdError(
      'bad_request',
      `a pull claim's requested_by is the service seat that announced (${row.announced_by})`,
    );
  return row;
}

/**
 * After the seat's claim landed: the announcement is `claimed`, `lane.pulled` joins the claim to
 * the announcement, `residency.pull_claimed` counts it (§8).
 */
export async function recordPullClaimed(
  db: Driver,
  teamId: string,
  row: PullAnnouncementRow,
  seatName: string,
  now = Date.now(),
): Promise<void> {
  if (!(await transition(db, row, 'granted', 'claimed', now, null))) return;
  const detail = {
    lane: row.lane_id,
    seat: seatName,
    host: row.host,
    announcement: row.id,
    ask: row.ask_id,
  };
  await appendLaneEventRequired(db, teamId, {
    actor: seatName,
    action: 'lane.pulled',
    target: row.lane_id,
    result: 'allow',
    detail,
  });
  await appendAudit(db, teamId, {
    actor: null,
    action: 'residency.pull_claimed',
    target: seatName,
    result: 'allow',
    detail,
  });
}

/**
 * The grant as a directed work order to the seat (§4.4): a `handoff` from the host's service seat
 * naming the lane — the ADR 199 dispatch-handoff shape, so the wake path is untouched and the
 * seat's first act in its wake is the first act in its name. Best-effort: the claim already holds.
 */
export async function deliverPullWorkOrder(
  ctx: Ctx,
  team: TeamRow,
  row: PullAnnouncementRow,
  lane: Lane,
): Promise<boolean> {
  const voice = await getMemberByName(ctx.db, team.id, row.announced_by);
  const seat = await getMemberById(ctx.db, row.member_id);
  if (!voice || !seat) return false;
  const pre = lane.pre_registered;
  try {
    await routeEnvelope(
      ctx,
      team,
      voice,
      makeEnvelope({
        id: ulid(),
        team: team.slug,
        from: voice.name,
        to: { kind: 'member', name: seat.name },
        act: 'handoff',
        body:
          `[pull] lane ${lane.id} "${lane.title}" is yours — pulled on host ${row.host} after ` +
          `the announcement lapsed (ask ${row.ask_id}). Run: ${pre?.run ?? '?'} ` +
          `Verdict rule: ${pre?.verdict_rule ?? '?'} Record in: ${pre?.record ?? '?'}`,
        meta: {
          lane_handoff: { lane: lane.id, ...(lane.branch ? { branch: lane.branch } : {}) },
          pull: { announcement: row.id, lane: lane.id, seat: seat.name, host: row.host },
        },
      }),
      undefined,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything that follows a landed pull claim, in one place for the hub's arbitration and the local
 * PATCH path: the announcement becomes `claimed`, the record rows land, and the work order goes
 * out. Nothing here can undo the claim; the work order is best-effort.
 */
export async function afterPullClaim(
  ctx: Ctx,
  team: TeamRow,
  lane: Lane,
  seatName: string,
  ask: string,
  now = Date.now(),
): Promise<void> {
  const row = await ctx.db.get<PullAnnouncementRow>(
    'SELECT * FROM pull_announcements WHERE team_id = ? AND ask_id = ?',
    [team.id, ask],
  );
  if (!row || row.state !== 'granted') return;
  await recordPullClaimed(ctx.db, team.id, row, seatName, now);
  await deliverPullWorkOrder(ctx, team, row, lane);
}

export interface PullRelease {
  lane: string;
  seat: string;
  host: string;
  reason: string;
}

/**
 * §5: a pulled lane is released when its host dies — after `release_after_expiries` expired wake
 * leases on the lane since the claim, or `release_after_ms` of host silence. Only a lane a pull
 * claimed and the same seat still holds in `claimed`/`active`; band 2 is redo-able, so the next
 * pull may take it elsewhere. Hub only.
 */
export async function releaseDeadPulls(
  ctx: Ctx,
  team: TeamRow,
  now = Date.now(),
): Promise<PullRelease[]> {
  const db = ctx.db;
  const policy = (await getPolicy(db, team.id)).pull;
  const hosts = await listHostSeen(db, team.id);
  const out: PullRelease[] = [];
  const claimed = await db.all<PullAnnouncementRow>(
    `SELECT * FROM pull_announcements WHERE team_id = ? AND state = 'claimed'`,
    [team.id],
  );
  for (const row of claimed) {
    const seat = await getMemberById(db, row.member_id);
    const lane = await getLane(db, team.id, row.lane_id, team.slug);
    if (!seat || !lane) continue;
    if (lane.owner_seat !== seat.name || (lane.state !== 'claimed' && lane.state !== 'active'))
      continue;
    const expiries = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM wake_leases
         WHERE team_id = ? AND member_id = ? AND lane_id = ? AND status = 'expired' AND created_at >= ?`,
      [team.id, seat.id, lane.id, row.decided_at ?? row.announced_at],
    );
    const seen = hosts.get(row.host) ?? 0;
    let reason: string | null = null;
    if ((expiries?.n ?? 0) >= policy.release_after_expiries)
      reason = `${expiries!.n} expired wake leases on host ${row.host}`;
    else if (now - seen >= policy.release_after_ms)
      reason = `host ${row.host} absent ${Math.round((now - seen) / 60_000)} min`;
    if (!reason) continue;
    await db.run(
      `UPDATE lanes SET state = 'open', owner_seat = NULL, claimed_at = NULL, updated_at = ?
         WHERE team_id = ? AND id = ? AND owner_seat = ?`,
      [now, team.id, lane.id, seat.name],
    );
    await db.run(`UPDATE pull_announcements SET reason = ? WHERE id = ?`, [
      `released: ${reason}`,
      row.id,
    ]);
    await appendLaneEventRequired(db, team.id, {
      actor: null,
      action: 'lane.pull_released',
      target: lane.id,
      result: 'allow',
      detail: {
        lane: lane.id,
        seat: seat.name,
        host: row.host,
        announcement: row.id,
        owner_before: seat.name,
        reason,
      },
    });
    out.push({ lane: lane.id, seat: seat.name, host: row.host, reason });
  }
  return out;
}
