/**
 * Halt as revocation (ADR 501), made Team-wide (ADR 525). The standing is a Team fact the hub owns:
 * it is decided once, on the hub, stamped as a replicated `seat.halted` / `seat.resumed` event, and
 * every node — the hub when it decides, each joiner when it folds the event — applies the same
 * LOCAL effects through this module: set the standing, revoke the seat's session leases, end its
 * presence rows, expire any unspawned wake lease. Before ADR 525 all of this ran only on the daemon
 * that took the request, so a seat halted on the hub kept working against a joiner.
 *
 * Live WebSocket eviction is not here: it needs the process's connection hub, which a fold running
 * inside a transaction does not have. The route evicts directly; the pull evicts after the fold for
 * every seat this module reports halted. Every refusal path (`memberStandingRefusal`, the claim
 * handshake, the gate) reads the standing, so the DB effects alone already stop the seat.
 */
import type { Driver } from '../db/driver.js';
import { appendAudit, appendReplicatedEvent } from './audit.js';
import { haltMember, markSessionEnded, resumeMember } from './members.js';
import { clearMemberPresence } from './presence.js';
import { revokeMemberSessionLeases } from './session-leases.js';

export interface HaltApplied {
  /** False when the seat was already halted — the first halt's reason stands. */
  changed: boolean;
  leases_revoked: number;
  wake_leases_expired: number;
}

/** The local effects of a halt on THIS node. Idempotent: an already-halted seat changes nothing. */
export async function applyHaltLocally(
  db: Driver,
  teamId: string,
  target: { id: string; name: string },
  by: string,
  reason: string,
  at: number,
): Promise<HaltApplied> {
  if (!(await haltMember(db, target.id, by, reason, at)))
    return { changed: false, leases_revoked: 0, wake_leases_expired: 0 };
  const leases = await revokeMemberSessionLeases(db, target.id, at);
  for (const leaseId of leases)
    await appendAudit(db, teamId, {
      actor: by,
      action: 'agent_session_lease.revoked',
      target: target.name,
      result: 'allow',
      detail: { lease_id: leaseId, reason: 'halt', cause: 'halt' },
    });
  await clearMemberPresence(db, target.id);
  await markSessionEnded(db, target.id);
  // An unspawned wake lease is a host about to start the seat: expire it so the host's next poll
  // finds nothing (ADR 501 §Consequences — `expired` reads the same to every consumer).
  const wakes = await db.run(
    "UPDATE wake_leases SET status = 'expired' WHERE team_id = ? AND member_id = ? AND status = 'leased' AND spawned_at IS NULL",
    [teamId, target.id],
  );
  return { changed: true, leases_revoked: leases.length, wake_leases_expired: wakes.changes };
}

/** The local effect of a resume on THIS node: clear the standing. False when it was not halted. */
export async function applyResumeLocally(
  db: Driver,
  target: { id: string },
  at: number,
): Promise<boolean> {
  return resumeMember(db, target.id, at);
}

/**
 * Stamp the decision for every other node (hub-side only). Carried by the `policy` sync kind —
 * the kind for hub-minted Team rules, refused from any node but the hub's own loopback — with
 * everything a fold needs to apply it identically: who, why, and the hub's `at`.
 */
export async function mintHaltEvent(
  db: Driver,
  teamId: string,
  verb: 'halt' | 'resume',
  e: {
    by: string;
    target: string;
    reason?: string;
    at: number;
    sponsor_scoped: boolean;
    /** Node-local counts and context for the record (leases revoked here, how long it was held). */
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await appendReplicatedEvent(db, teamId, {
    actor: e.by,
    action: verb === 'halt' ? 'seat.halted' : 'seat.resumed',
    target: e.target,
    result: 'allow',
    detail: {
      ...e.extra,
      at: e.at,
      sponsor_scoped: e.sponsor_scoped,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    },
  });
}
