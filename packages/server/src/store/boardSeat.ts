import type { Driver } from '../db/driver.js';
import { addMember, getMemberByName } from './members.js';
import type { MemberRow, TeamRow } from './rows.js';

/**
 * The team's `board` service seat: what the daemon speaks as when it composes a coordination notice
 * nobody wrote — the dispatch nudge (ADR 646) and the incident notices (ADR 649). An ADR 232 ledger
 * seat, never a lane owner, minted on first use like `digest` and `policy`. A service seat is never
 * bound to a node (`sync/log.ts`), so a notice minted on any node pushes cleanly.
 */
export const BOARD_SEAT = 'board';

/** The `board` seat, minted on first use. Null when the name is already held by a seat that is not
 *  a live service seat: the board never speaks as somebody's agent or person. */
export async function boardSeat(db: Driver, team: TeamRow): Promise<MemberRow | null> {
  const existing = await getMemberByName(db, team.id, BOARD_SEAT);
  if (existing) return existing.kind === 'service' && existing.left_at === null ? existing : null;
  return (await addMember(db, team, { name: BOARD_SEAT, kind: 'service' })).row;
}
