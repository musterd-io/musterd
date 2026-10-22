import {
  type HostProvision,
  type HostProvisionKind,
  HostProvisionMoveSchema,
  type HostProvisionReportBody,
  type HostProvisionState,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { getMemberById, memberStandingRefusal } from './members.js';
import { type HostScope, hostMayServe } from './residency.js';
import { resolveAccountStatus } from './rows.js';

/**
 * ADR 463 §2 — sponsor-host provisions. A sponsored agent minted while its sponsor has a live host
 * gets one `pending` row; the sponsor's own host key claims it (one claimant, capped per host),
 * stands the seat up, and reports `ready` or `failed`. A `ready` row yields exactly one
 * `provisioned` wake (`takeProvisionedWake` in residency.ts). A row nobody claims in 15 minutes is cancelled and
 * the sponsor gets the connect link instead — nothing is stuck.
 */

export const PROVISION_PENDING_TTL_MS = 15 * 60 * 1000;
/** A sponsor's host counts as live if one of its keys polled within this window (ADR 463 §2). */
export const SPONSOR_HOST_LIVE_MS = 10 * 60 * 1000;

export interface HostProvisionRow {
  id: string;
  team_id: string;
  member_id: string;
  sponsor_id: string;
  host: string | null;
  state: HostProvisionState;
  claimed_by: string | null;
  claimed_at: number | null;
  ready_at: number | null;
  first_wake_at: number | null;
  failed_reason: string | null;
  /** The public origin the mint was reached at — the fallback connect link is built on it. */
  connect_origin: string | null;
  created_at: number;
  /** ADR 703. `mint` for every row written before the column existed. */
  kind: HostProvisionKind;
  /** JSON `{ harness, policy }` for a move; null for a mint. */
  move_json: string | null;
}

export async function insertProvision(
  db: Driver,
  teamId: string,
  memberId: string,
  sponsorId: string,
  now = Date.now(),
  connectOrigin: string | null = null,
  /** Lane 01M5DR34Y2: the host label this row is pinned to — only that host claims it. `null` is
   *  ADR 463 §2's original shape: any live host of the sponsor's claims it, first poll wins. */
  host: string | null = null,
  kind: HostProvisionKind = 'mint',
  moveJson: string | null = null,
): Promise<HostProvisionRow> {
  const row: HostProvisionRow = {
    id: ulid(),
    team_id: teamId,
    member_id: memberId,
    sponsor_id: sponsorId,
    host,
    state: 'pending',
    claimed_by: null,
    claimed_at: null,
    ready_at: null,
    first_wake_at: null,
    failed_reason: null,
    connect_origin: connectOrigin,
    created_at: now,
    kind,
    move_json: moveJson,
  };
  await db.run(
    `INSERT INTO host_provisions (id, team_id, member_id, sponsor_id, host, state, claimed_by,
       claimed_at, ready_at, first_wake_at, failed_reason, connect_origin, created_at, kind, move_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.team_id,
      row.member_id,
      row.sponsor_id,
      row.host,
      row.state,
      row.claimed_by,
      row.claimed_at,
      row.ready_at,
      row.first_wake_at,
      row.failed_reason,
      row.connect_origin,
      row.created_at,
      row.kind,
      row.move_json,
    ],
  );
  return row;
}

export async function getProvision(
  db: Driver,
  teamId: string,
  id: string,
): Promise<HostProvisionRow | undefined> {
  return await db.get<HostProvisionRow>(
    'SELECT * FROM host_provisions WHERE team_id = ? AND id = ?',
    [teamId, id],
  );
}

/** Host labels this sponsor's host keys polled from within `withinMs` — newest first. */
export async function sponsorHostsSeen(
  db: Driver,
  teamId: string,
  sponsorId: string,
  now = Date.now(),
  withinMs = SPONSOR_HOST_LIVE_MS,
): Promise<string[]> {
  return (
    await db.all<{ host: string }>(
      `SELECT host FROM host_liveness WHERE team_id = ? AND sponsor_id = ? AND seen_at >= ?
       ORDER BY seen_at DESC`,
      [teamId, sponsorId, now - withinMs],
    )
  ).map((r) => r.host);
}

/**
 * Sponsored seats this host label already runs or is standing up — the `max_per_host` count.
 * Live hosted enrollments plus in-flight claims, so a burst of claims cannot overshoot the cap.
 */
export async function liveHostedCount(db: Driver, teamId: string, host: string): Promise<number> {
  const hosted = (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM residency r JOIN members m ON m.id = r.member_id
       WHERE r.team_id = ? AND r.host = ? AND m.sponsored_by IS NOT NULL AND m.left_at IS NULL`,
    [teamId, host],
  ))!.n;
  const inFlight = (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM host_provisions p
       WHERE p.team_id = ? AND p.claimed_by = ? AND p.state = 'claimed'
         AND NOT EXISTS (SELECT 1 FROM residency r WHERE r.member_id = p.member_id AND r.host = p.claimed_by)`,
    [teamId, host],
  ))!.n;
  return hosted + inFlight;
}

/**
 * Atomic: the pending rows this key may serve (`hostMayServe` — a sponsored seat only from its
 * sponsor's own key) become `claimed` by `host`, oldest first, up to `maxPerHost` hosted seats on
 * the label. Rows past the cap stay pending for a later poll or another host of the sponsor's.
 * A row pinned to another label (`host` set at insert) is left alone: with two live hosts of one
 * sponsor, whichever polled first used to take every row, and standing a seat up on the OTHER
 * machine meant stopping the first (three times on 2026-10-20, lane 01M5DR34Y2).
 */
export async function claimProvisions(
  db: Driver,
  teamId: string,
  host: string,
  scope: HostScope,
  maxPerHost: number,
  now = Date.now(),
  /**
   * ADR 703: omitted means mint only. A host binary that does not know `move` must not be
   * handed one — it would stand the seat up as a new sponsored agent.
   */
  kinds: readonly HostProvisionKind[] = ['mint'],
): Promise<HostProvisionRow[]> {
  return db.tx(async (t): Promise<HostProvisionRow[]> => {
    const pending = await t.all<HostProvisionRow>(
      "SELECT * FROM host_provisions WHERE team_id = ? AND state = 'pending' ORDER BY created_at ASC, id ASC",
      [teamId],
    );
    let room = maxPerHost - (await liveHostedCount(t, teamId, host));
    const claimed: HostProvisionRow[] = [];
    for (const row of pending) {
      if (room <= 0) break;
      if (!kinds.includes(row.kind ?? 'mint')) continue;
      if (row.host !== null && row.host !== host) continue;
      const agent = await getMemberById(t, row.member_id);
      if (!agent || agent.left_at !== null || !hostMayServe(scope, agent)) continue;
      const took = await t.run(
        `UPDATE host_provisions SET state = 'claimed', host = ?, claimed_by = ?, claimed_at = ?
           WHERE id = ? AND state = 'pending'`,
        [host, host, now, row.id],
      );
      if (took.changes !== 1) continue;
      room -= 1;
      claimed.push({ ...row, state: 'claimed', host, claimed_by: host, claimed_at: now });
    }
    return claimed;
  });
}

export async function failProvision(db: Driver, id: string, reason: string): Promise<void> {
  await db.run(
    "UPDATE host_provisions SET state = 'failed', failed_reason = ? WHERE id = ? AND state IN ('pending','claimed')",
    [reason, id],
  );
}

/**
 * The claimant's report. Only the host that claimed the row may report, and only once. A `ready`
 * report is refused — the row failed `sponsor_lost_standing` / `agent_lost_standing` and the
 * refusal returned, never thrown, so the failure commits — if either lost standing since the claim
 * (ADR 463 §2, Review Focus 2).
 */
export async function reportProvision(
  db: Driver,
  teamId: string,
  id: string,
  host: string,
  body: HostProvisionReportBody,
  now = Date.now(),
): Promise<{
  row: HostProvisionRow;
  refused: 'sponsor_lost_standing' | 'agent_lost_standing' | null;
}> {
  return db.tx(async (t) => {
    const row = await getProvision(t, teamId, id);
    if (!row) throw new MusterdError('not_found', `no provision "${id}"`);
    if (row.claimed_by !== host)
      throw new MusterdError('conflict', `provision "${id}" is not claimed by host "${host}"`);
    if (row.state !== 'claimed')
      throw new MusterdError('conflict', `provision "${id}" was already reported (${row.state})`);
    if (body.state === 'failed') {
      await failProvision(t, id, body.reason);
      return {
        row: { ...row, state: 'failed' as const, failed_reason: body.reason },
        refused: null,
      };
    }
    const sponsor = await getMemberById(t, row.sponsor_id);
    const agent = await getMemberById(t, row.member_id);
    const sponsorLost = !sponsor || memberStandingRefusal(sponsor, now) !== null;
    const agentStatus = agent ? resolveAccountStatus(agent) : null;
    const agentLost =
      !agent || agent.left_at !== null || agentStatus === 'disabled' || agentStatus === 'banned';
    if (sponsorLost || agentLost) {
      const reason = sponsorLost
        ? ('sponsor_lost_standing' as const)
        : ('agent_lost_standing' as const);
      await failProvision(t, id, reason);
      return { row: { ...row, state: 'failed' as const, failed_reason: reason }, refused: reason };
    }
    await t.run("UPDATE host_provisions SET state = 'ready', ready_at = ? WHERE id = ?", [now, id]);
    return { row: { ...row, state: 'ready' as const, ready_at: now }, refused: null };
  });
}

/** The newest provisions, for `musterd host provisions` — unclaimed and claimed rows included. */
export async function listProvisions(
  db: Driver,
  teamId: string,
  limit = 50,
): Promise<HostProvisionRow[]> {
  return await db.all<HostProvisionRow>(
    'SELECT * FROM host_provisions WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [teamId, limit],
  );
}

/** What the sweep did to one row, and why. */
export interface SweptProvision {
  row: HostProvisionRow;
  reason: 'unclaimed' | 'agent_left' | 'sponsor_lost_standing' | 'not_reported';
}

/**
 * Nothing is stuck (ADR 463 §2). One pass settles every open row that can no longer finish:
 * - its agent left → `cancelled` (`agent_left`);
 * - its sponsor lost standing → `failed` (`sponsor_lost_standing`) — the sponsor's host keys stop
 *   working at that moment (ADR 463 §1), so its host could never report;
 * - `pending` past the TTL → `cancelled` (`unclaimed`);
 * - `claimed` past the TTL with no report → `failed` (`not_reported`).
 * The caller hands a sponsor still in standing the connect link instead.
 */
export async function sweepProvisions(db: Driver, now = Date.now()): Promise<SweptProvision[]> {
  return db.tx(async (t): Promise<SweptProvision[]> => {
    const open = await t.all<HostProvisionRow>(
      "SELECT * FROM host_provisions WHERE state IN ('pending','claimed') ORDER BY created_at ASC",
    );
    const cutoff = now - PROVISION_PENDING_TTL_MS;
    const out: SweptProvision[] = [];
    for (const row of open) {
      const agent = await getMemberById(t, row.member_id);
      const sponsor = await getMemberById(t, row.sponsor_id);
      let reason: SweptProvision['reason'] | null = null;
      if (!agent || agent.left_at !== null) reason = 'agent_left';
      else if (!sponsor || memberStandingRefusal(sponsor, now) !== null)
        reason = 'sponsor_lost_standing';
      else if (row.state === 'pending' && row.created_at <= cutoff) reason = 'unclaimed';
      else if (row.state === 'claimed' && (row.claimed_at ?? row.created_at) <= cutoff)
        reason = 'not_reported';
      if (reason === null) continue;
      const state = reason === 'unclaimed' || reason === 'agent_left' ? 'cancelled' : 'failed';
      const changed = await t.run(
        `UPDATE host_provisions SET state = ?, failed_reason = ?
           WHERE id = ? AND state IN ('pending','claimed')`,
        [state, state === 'failed' ? reason : null, row.id],
      );
      if (changed.changes !== 1) continue;
      out.push({
        row: { ...row, state, failed_reason: state === 'failed' ? reason : null },
        reason,
      });
    }
    return out;
  });
}

export function toProvision(
  row: HostProvisionRow,
  teamSlug: string,
  agentName: string,
  sponsorName: string,
): HostProvision {
  let move: HostProvision['move'] = null;
  if (row.kind === 'move' && row.move_json) {
    try {
      const parsed = HostProvisionMoveSchema.safeParse(JSON.parse(row.move_json));
      if (parsed.success) move = parsed.data;
    } catch {
      move = null;
    }
  }
  return {
    id: row.id,
    team: teamSlug,
    agent: agentName,
    sponsor: sponsorName,
    host: row.host,
    state: row.state,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    ready_at: row.ready_at,
    failed_reason: row.failed_reason,
    created_at: row.created_at,
    kind: row.kind ?? 'mint',
    move,
  };
}
