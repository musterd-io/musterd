import type { Driver } from '../db/driver.js';

/**
 * ADR 697 — what a hold's hand-over needs, kept daemon-local (ladder v123).
 *
 * A seat refused a file another lane held (ADR 691) is remembered here until its first edit of that
 * file after the hold ends; that edit is the hand-over. The path lives in this table, never in the
 * shapes-only `lane.gate` audit row (ADR 150). `lane_heads` keeps the last HEAD an edit inside a lane
 * reported, so the hand-over can name a commit as well as a branch.
 */

export interface HoldRefusal {
  holder: string;
  holder_lane_id: string;
  refused_at: number;
}

/** Remember that `seat` was refused `path` because `holderLaneId` (owned by `holder`) held it. */
export async function recordHoldRefusal(
  db: Driver,
  teamId: string,
  seat: string,
  path: string,
  holder: string,
  holderLaneId: string,
  now = Date.now(),
): Promise<void> {
  // A new refusal re-arms the hand-over, even after an earlier one was given: it is a new hold.
  await db.run(
    `INSERT INTO gate_hold_refusals (team_id, seat, path, holder, holder_lane_id, refused_at, handed_over_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (team_id, seat, path) DO UPDATE SET
       holder = excluded.holder, holder_lane_id = excluded.holder_lane_id,
       refused_at = excluded.refused_at, handed_over_at = NULL`,
    [teamId, seat, path, holder, holderLaneId, now],
  );
}

/**
 * Claim the pending hand-over for `seat` on `path`, if there is one: marks it given and returns it,
 * atomically, so two concurrent edits cannot both be refused for it. Null when none is pending.
 */
export async function takeHandover(
  db: Driver,
  teamId: string,
  seat: string,
  path: string,
  now = Date.now(),
): Promise<HoldRefusal | null> {
  return db.tx(async (t) => {
    const row = await t.get<HoldRefusal>(
      `SELECT holder, holder_lane_id, refused_at FROM gate_hold_refusals
        WHERE team_id = ? AND seat = ? AND path = ? AND handed_over_at IS NULL`,
      [teamId, seat, path],
    );
    if (!row) return null;
    await t.run(
      'UPDATE gate_hold_refusals SET handed_over_at = ? WHERE team_id = ? AND seat = ? AND path = ?',
      [now, teamId, seat, path],
    );
    return { ...row, refused_at: Number(row.refused_at) };
  });
}

/** Record the HEAD an allowed edit inside `laneId` reported. */
export async function recordLaneHead(
  db: Driver,
  teamId: string,
  laneId: string,
  head: string,
  now = Date.now(),
): Promise<void> {
  await db.run(
    `INSERT INTO lane_heads (team_id, lane_id, head, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (team_id, lane_id) DO UPDATE SET head = excluded.head, at = excluded.at`,
    [teamId, laneId, head, now],
  );
}

export async function laneHead(db: Driver, teamId: string, laneId: string): Promise<string | null> {
  const row = await db.get<{ head: string }>(
    'SELECT head FROM lane_heads WHERE team_id = ? AND lane_id = ?',
    [teamId, laneId],
  );
  return row?.head ?? null;
}
