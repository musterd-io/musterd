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
 * Only rows carrying this lease are touched: a session the seat's human or another wake holds is
 * not this wake's, and its hold stands. Rows already past their hold, or with none, are left alone.
 * The reaper frees the row on its next pass, as it would have at `held_until`.
 */
export async function releaseWakeHold(
  db: Driver,
  leaseId: string,
  now = Date.now(),
): Promise<number> {
  const res = await db.run(
    'UPDATE presence SET held_until = ? WHERE wake_lease = ? AND held_until IS NOT NULL AND held_until > ?',
    [now, leaseId, now],
  );
  return res.changes ?? 0;
}
