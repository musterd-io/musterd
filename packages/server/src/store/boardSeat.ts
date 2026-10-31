import { randomBytes } from 'node:crypto';
import type { Driver } from '../db/driver.js';
import { addMember, getMemberByName, hashToken } from './members.js';
import type { MemberRow, TeamRow } from './rows.js';

/**
 * The team's `board` service seat: what the daemon speaks as when it composes a coordination notice
 * nobody wrote — the dispatch nudge (ADR 646) and the incident notices (ADR 649). An ADR 232 ledger
 * seat, never a lane owner, minted on first use like `digest` and `policy`. A service seat is never
 * bound to a node (`sync/log.ts`), so a notice minted on any node pushes cleanly.
 */
export const BOARD_SEAT = 'board';

/**
 * The service seats the daemon mints for itself and speaks as. They have no seat file, so roster
 * reconcile must never retire them for being absent from the files: on revive it did, on
 * 2026-10-18, and every notice the board sends went silent (lane 01M69N8GR2).
 */
export const DAEMON_SERVICE_SEATS: ReadonlySet<string> = new Set([BOARD_SEAT, 'policy']);

/**
 * A daemon service seat by name: the live row, a retired service row brought back, or a fresh one.
 * Null when the name is held by a seat that is not a service seat: the daemon never speaks as
 * somebody's agent or person.
 */
export async function daemonServiceSeat(
  db: Driver,
  team: TeamRow,
  name: string,
  now: number = Date.now(),
): Promise<MemberRow | null> {
  const existing = await getMemberByName(db, team.id, name);
  if (!existing) return (await addMember(db, team, { name, kind: 'service' })).row;
  if (existing.kind !== 'service') return null;
  if (existing.left_at === null) return existing;
  // A token nobody holds, and unbound: whatever credential the row had before it was retired stays
  // dead (as `reviveMember` re-mints). The daemon speaks as this seat without one.
  await db.run(
    `UPDATE members SET left_at = NULL, token_hash = ?, bound_at = NULL, updated_at = ?
      WHERE id = ? AND kind = 'service'`,
    [hashToken(randomBytes(32).toString('hex')), now, existing.id],
  );
  return (await getMemberByName(db, team.id, name)) ?? null;
}

/** The `board` seat, minted on first use (see {@link daemonServiceSeat}). */
export async function boardSeat(db: Driver, team: TeamRow): Promise<MemberRow | null> {
  return daemonServiceSeat(db, team, BOARD_SEAT);
}
