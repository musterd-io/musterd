import type { Activity, StateSource } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';

export interface ActivityResolution {
  activity: Activity;
  state: string | null;
  last_status_at: number | null;
  /** ADR 726: what the label came from — a status_update, the seat's claimed lane, or steering. */
  state_source: StateSource | null;
}

/** ADR 726: an agent seat's claimed work, for deriving `working` without a status_update. */
export interface LaneWork {
  /** The most recently claimed lane in `claimed` or `active` state. */
  title: string;
  /** How many other such lanes the seat owns. */
  others: number;
  /** The seat's last audited action (quiescence's `lastActionBySubject`). */
  lastActionAt: number;
}

/**
 * The two-clocks rule (ADR 010 / v0.2 M2; idle rename ADR 140), plus the steering signal (ADR 155
 * Increment 1). Independent clocks decide a member's activity:
 *  - **liveness** (presence heartbeat) gates `offline` vs. present;
 *  - **the latest `status_update`** gates `active` (present, no fresh claim) vs. `working`;
 *  - **steering** — a human named as the `driver` of a *live* agent seat — marks `working` on its
 *    own, present even without the human's own heartbeat. "I steer, therefore I'm working" (ADR 155):
 *    steering *is* a real action (ADR 057), so it composes here at read time rather than through a
 *    synthetic presence row. It keeps the human's own status text as the label when there is one.
 *
 * `idleAfterMs` is the ADR 155 Increment 3 decay heuristic, now passed for **everyone**
 * (presence-honesty §2.1): humans keep the presence timeout; agents get their own generous window
 * (`agentIdleMs`) — `working` requires *fresh* evidence. Past the window the read decays to
 * `active` (the wire rename of `idle`), derived at read time, no stored state, no writer — and the
 * claim is KEPT with its age: `state` and `last_status_at` survive so the renderer can say
 * `last: "<status>" · 20m ago` instead of erasing history. Steering outranks the decay: a live
 * driver link is a *current* action, not a stale report. With no window passed the ADR 010
 * never-silently-revert read holds.
 */
export function resolveActivity(
  live: boolean,
  lastStatus: { state: string; ts: number } | null,
  steering = false,
  idleAfterMs?: number,
  /** ADR 726: agents only — the caller passes null for humans. */
  laneWork: LaneWork | null = null,
  now = Date.now(),
): ActivityResolution {
  if (steering)
    return {
      activity: 'working',
      state: lastStatus?.state ?? null,
      last_status_at: lastStatus?.ts ?? null,
      state_source: 'steering',
    };
  if (!live) return { activity: 'offline', state: null, last_status_at: null, state_source: null };
  const fresh = (ts: number) => idleAfterMs === undefined || now - ts <= idleAfterMs;
  const laneLabel = laneWork
    ? laneWork.others > 0
      ? `${laneWork.title} (+${laneWork.others} more)`
      : laneWork.title
    : null;
  // A fresh status wins: it is the agent saying something more specific than its lane's title. The
  // send is itself an audited action, so "newer than the lane evidence" would never hold for it.
  if (lastStatus && fresh(lastStatus.ts))
    return {
      activity: 'working',
      state: lastStatus.state,
      last_status_at: lastStatus.ts,
      state_source: 'status',
    };
  // ADR 726: a live agent that owns a claimed lane and acted inside the window is working on it.
  if (laneWork && fresh(laneWork.lastActionAt))
    return {
      activity: 'working',
      state: laneLabel,
      last_status_at: laneWork.lastActionAt,
      state_source: 'lane',
    };
  // Decay (ADR 316 Decision 2): `active`, with the newest claim kept and aged.
  if (lastStatus && (!laneWork || lastStatus.ts >= laneWork.lastActionAt))
    return {
      activity: 'active',
      state: lastStatus.state,
      last_status_at: lastStatus.ts,
      state_source: 'status',
    };
  if (laneWork)
    return {
      activity: 'active',
      state: laneLabel,
      last_status_at: laneWork.lastActionAt,
      state_source: 'lane',
    };
  return { activity: 'active', state: null, last_status_at: null, state_source: null };
}

/**
 * ADR 726: each seat's claimed work, in one read for the roster — the most recently claimed lane in
 * `claimed` or `active` state, and how many more it owns. Keyed by seat name, like
 * `lastActionBySubject`. A `blocked` lane does not count: its owner is not working on it.
 */
export async function claimedLanesByOwner(
  db: Driver,
  teamId: string,
): Promise<Map<string, { title: string; others: number }>> {
  const rows = await db.all<{ owner_seat: string; title: string }>(
    `SELECT owner_seat, title FROM lanes
      WHERE team_id = ? AND state IN ('claimed', 'active') AND owner_seat IS NOT NULL
      ORDER BY claimed_at DESC`,
    [teamId],
  );
  const out = new Map<string, { title: string; others: number }>();
  for (const r of rows) {
    const seen = out.get(r.owner_seat);
    if (seen) seen.others += 1;
    else out.set(r.owner_seat, { title: r.title, others: 0 });
  }
  return out;
}
