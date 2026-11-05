import { RECLAIM_GRACE_MS } from '../config.js';
import type { Driver } from '../db/driver.js';
import { getMemberByName } from './members.js';
import { effectiveWakePolicy, getResidency, seatWakeDefaults } from './residency.js';
import { getPolicy } from './teams.js';

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

/**
 * ADR 804, second amendment (2026-11-05): a hold that parks AFTER the report. The harness runs its
 * SessionEnd hook as the process winds down, and the host reports the wake the moment the run's
 * output closes — so the hook's own short session (no lease on its row) can park its reclaim hold a
 * few seconds after the daemon released everything it could see (smoke pair 2 of the rider 7 re-run:
 * `reclaimable` resumed ~7 s after each report and held 40–80 s). Each poll, before the reclaimable
 * gate is read, a leaseless hold on a seat whose newest lease was reported within `windowMs` and
 * minted before the row was last seen is released: it belongs to a run the host has already said
 * is over. A live connection, or a seat with no recent reported lease, is untouched. The row may
 * carry the lease itself: the hooks run with `MUSTERD_WAKE_LEASE` in their environment, so the
 * SessionEnd hook's CLI claim is stamped with the wake's lease and parks at the report's own second
 * (smoke pair 3, 01:36:38Z: `cli`, lease set, created at the report, held 45 s) — the lease-only
 * release at the report ran before that row existed, and a `wake_lease IS NULL` filter here missed it.
 *
 * ADR 809: the same sweep releases the holds an act-lane seat's own attended session left when its
 * harness exited (`releaseExitedSessionHolds`) — the one hold the report never speaks for.
 */
export async function releaseLateWakeHolds(
  db: Driver,
  teamId: string,
  now = Date.now(),
  windowMs = 5 * 60_000,
): Promise<number> {
  const exited = await releaseExitedSessionHolds(db, teamId, now, windowMs);
  const res = await db.run(
    `UPDATE presence SET held_until = ?
       WHERE id IN (
         SELECT p.id FROM presence p
           JOIN wake_leases l ON l.member_id = p.member_id AND l.team_id = ?
          WHERE p.conn_id IS NULL AND p.held_until IS NOT NULL AND p.held_until > ?
            AND l.status = 'reported' AND l.created_at >= ? AND l.created_at <= p.last_seen_at
       )`,
    [now, teamId, now, now - windowMs],
  );
  return (res.changes ?? 0) + exited;
}

/** How long after the `residency.session_ended` row the exiting run's own rows may still park: the
 *  harness closes its MCP session before the SessionEnd hook posts, and the hook's own CLI claim
 *  closes after it (ADR 804's second amendment measured ~7 s). A row parked later than this belongs
 *  to a new session, and its hold stands. */
export const EXIT_SETTLE_MS = 60_000;

/** Ordering slack between a presence row's `created_at` and the audit row's `ts`: both are stamped
 *  by this daemon's clock, in that order (the hook's own CLI claim is the session that posts the
 *  attestation), so the slack only covers a row inserted in the same millisecond. */
export const EXIT_ORDER_SLACK_MS = 2_000;

/**
 * ADR 809: a harness exit releases the reclaim hold on the act lane. The seat's first session on
 * a CooperBench pair is not a wake — the arm starts `claude -p` itself — so no lease is minted, no
 * report arrives, and ADR 804 has nothing to release; finding 032 read `reclaimable` on every seat's
 * first wake as exactly that session's 45 s grace (30% of the held wait time, ~40 s a wait). The
 * daemon already learns the exit: the SessionEnd hook's `musterd session end` posts
 * `POST /residency/session {event: 'end'}`, audited as `residency.session_ended` on the seat. A
 * process that has run its SessionEnd hook is not coming back to reclaim its socket, and on the act
 * lane (ADR 735) its ending IS the seat's turn ending — the next act should wake it on the host's
 * next poll, not after the grace.
 *
 * Each poll: for every seat with a `residency.session_ended` row within `windowMs`, enrolled on this
 * team with an effective `lane: act`, release the parked rows last seen between the grace before that
 * row's `ts` (the MCP session, which closes first) and `EXIT_SETTLE_MS` after it (the hook's own CLI
 * claim) — **and created no later than that row** (amended 2026-11-05, big-body's acceptance read):
 * every session of the exiting run attached before its hook posted the exit, and a session the
 * seat's person starts after it is new whatever it does inside the settle window, so its hold
 * stands. A live connection, a row parked outside that span, a seat on any other lane, and an
 * unenrolled seat are untouched: on the interrupt and batched lanes a person's exit-and-relaunch
 * keeps the reclaim grace it has today (ADR 804's first rejected option, still rejected).
 */
export async function releaseExitedSessionHolds(
  db: Driver,
  teamId: string,
  now = Date.now(),
  windowMs = 5 * 60_000,
  graceMs = RECLAIM_GRACE_MS,
): Promise<number> {
  const exits = await db.all<{ name: string; ts: number }>(
    `SELECT target AS name, MAX(ts) AS ts FROM audit
      WHERE team_id = ? AND action = 'residency.session_ended' AND ts >= ? AND target IS NOT NULL
      GROUP BY target`,
    [teamId, now - windowMs],
  );
  if (exits.length === 0) return 0;
  const teamPolicy = await getPolicy(db, teamId);
  let released = 0;
  for (const exit of exits) {
    const member = await getMemberByName(db, teamId, exit.name);
    if (!member || member.left_at !== null) continue;
    const enrollment = await getResidency(db, teamId, member.id);
    if (!enrollment) continue;
    const policy = effectiveWakePolicy(seatWakeDefaults(teamPolicy, member), enrollment.policy);
    if (policy.lane !== 'act') continue;
    const res = await db.run(
      `UPDATE presence SET held_until = ?
         WHERE member_id = ? AND conn_id IS NULL AND held_until IS NOT NULL AND held_until > ?
           AND last_seen_at >= ? AND last_seen_at <= ? AND created_at <= ?`,
      [
        now,
        member.id,
        now,
        exit.ts - graceMs,
        exit.ts + EXIT_SETTLE_MS,
        exit.ts + EXIT_ORDER_SLACK_MS,
      ],
    );
    released += res.changes ?? 0;
  }
  return released;
}
