import type { Driver } from '../db/driver.js';

/**
 * ADR 804: a settled wake releases its reclaim hold. When a wake's harness process exits, its
 * websocket closes cleanly and `release` parks the presence row as a reclaim hold for the grace
 * window (ADR 010, 45 s by default). On the act lane (ADR 735) that hold is the seat's own just-ended
 * wake, and `deriveSeatPasses`' `reclaimable` gate (ADR 753 state 2) then holds the seat's NEXT wake
 * until the window lapses — finding 031 measured the backlog that builds behind it (24 s → 5m42s
 * over fourteen acts). The host's wake report is the moment the daemon knows the run is over and
 * nothing is coming back to reclaim it, so the hold ends there.
 *
 * Rows released: the seat's parked rows that carry this lease, or were last seen since the lease
 * was minted (the wake's own hook sessions, which carry no lease — ADR 804 amendment 2026-11-05).
 * A row with a live connection, one parked before this wake began, or another member's row is
 * never touched. The reaper frees the row on its next pass, as it would have at `held_until`.
 */
export async function releaseWakeHold(
  db: Driver,
  lease: { id: string; member_id: string; created_at: number },
  now = Date.now(),
): Promise<number> {
  // The wake's own MCP session carries the lease id. Its hooks (`musterd session start/end`, the
  // interrupt probe) open short CLI sessions as the seat with no lease on their rows, and the
  // SessionEnd hook's close is the LAST close before the report — so it is that row's 45 s hold
  // that held the next wake in the 2026-11-05 smoke pair (reclaimable ≈ 40 s on every wait with
  // the lease-only release in place). At report time the seat has no live connection, so every
  // parked row of the seat that was last seen since the lease was minted belongs to this wake.
  const res = await db.run(
    `UPDATE presence SET held_until = ?
       WHERE member_id = ? AND conn_id IS NULL AND held_until IS NOT NULL AND held_until > ?
         AND (wake_lease = ? OR last_seen_at >= ?)`,
    [now, lease.member_id, now, lease.id, lease.created_at],
  );
  return res.changes ?? 0;
}
