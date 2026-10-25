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
  // A new refusal re-arms the hand-over, even after an earlier one was given: it is a new hold. It
  // re-arms the ADR 724 watch the same way.
  await db.run(
    `INSERT INTO gate_hold_refusals (team_id, seat, path, holder, holder_lane_id, refused_at, handed_over_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (team_id, seat, path) DO UPDATE SET
       holder = excluded.holder, holder_lane_id = excluded.holder_lane_id,
       refused_at = excluded.refused_at, handed_over_at = NULL, watch_fired_at = NULL`,
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

/** ADR 724: a held refusal still watching its holder's lane. */
export interface PendingWatch {
  team_id: string;
  seat: string;
  path: string;
  holder: string;
  holder_lane_id: string;
  refused_at: number;
}

/**
 * Every watch not yet answered: the refused seat has not been told the file is free, and has not
 * already edited it through the ADR 697 hand-over (then it knows).
 */
export async function pendingWatches(db: Driver): Promise<PendingWatch[]> {
  const rows = await db.all<PendingWatch>(
    `SELECT team_id, seat, path, holder, holder_lane_id, refused_at FROM gate_hold_refusals
      WHERE watch_fired_at IS NULL AND handed_over_at IS NULL`,
  );
  return rows.map((r) => ({ ...r, refused_at: Number(r.refused_at) }));
}

/** Close the watches for these paths: the seat was told, or the watch aged out. */
export async function closeWatches(
  db: Driver,
  teamId: string,
  seat: string,
  paths: string[],
  now = Date.now(),
): Promise<void> {
  for (const path of paths) {
    await db.run(
      `UPDATE gate_hold_refusals SET watch_fired_at = ?
        WHERE team_id = ? AND seat = ? AND path = ? AND watch_fired_at IS NULL`,
      [now, teamId, seat, path],
    );
  }
}

/** A handoff moved the hold (ADR 691 §2): the watch stays, now on the new owner. */
export async function moveWatchHolder(
  db: Driver,
  teamId: string,
  seat: string,
  paths: string[],
  holder: string,
): Promise<void> {
  for (const path of paths) {
    await db.run(
      'UPDATE gate_hold_refusals SET holder = ? WHERE team_id = ? AND seat = ? AND path = ?',
      [holder, teamId, seat, path],
    );
  }
}

/** ADR 730: a seat with an open watch on a lane, and the path it was refused. */
export interface LaneWatcher {
  seat: string;
  path: string;
}

/** The seats still watching `laneId` (ADR 724 watches not yet answered or handed over). */
export async function watchersOfLane(
  db: Driver,
  teamId: string,
  laneId: string,
): Promise<LaneWatcher[]> {
  return db.all<LaneWatcher>(
    `SELECT seat, path FROM gate_hold_refusals
      WHERE team_id = ? AND holder_lane_id = ? AND watch_fired_at IS NULL AND handed_over_at IS NULL
      ORDER BY seat, path`,
    [teamId, laneId],
  );
}

/**
 * ADR 730 §2: record that the lane's branch reached `remote` at `head` (ladder v132 columns on the
 * ADR 697 row). Returns the head announced before, so the caller sends nothing for a repeat push of
 * the same commit.
 */
export async function recordLanePush(
  db: Driver,
  teamId: string,
  laneId: string,
  remote: string,
  head: string,
  now = Date.now(),
): Promise<{ previous_head: string | null }> {
  return db.tx(async (t) => {
    const row = await t.get<{ pushed_head: string | null }>(
      'SELECT pushed_head FROM lane_heads WHERE team_id = ? AND lane_id = ?',
      [teamId, laneId],
    );
    await t.run(
      `INSERT INTO lane_heads (team_id, lane_id, head, at, pushed_head, pushed_remote, pushed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, lane_id) DO UPDATE SET
         pushed_head = excluded.pushed_head, pushed_remote = excluded.pushed_remote, pushed_at = excluded.pushed_at`,
      [teamId, laneId, head, now, head, remote, now],
    );
    return { previous_head: row?.pushed_head ?? null };
  });
}
