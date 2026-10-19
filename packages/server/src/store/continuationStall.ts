import {
  AvailabilitySchema,
  type Availability,
  type Lane,
  type LaneWarning,
  type LoopEdge,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';

/*
 * When does a claimed lane's dispatch continuation come due again (ADR 306 §2, ADR 661), and the
 * board's word for one that will not (ADR 664). Its own module so `lanes.ts` can ask without
 * importing the residency store, which imports it.
 */

/**
 * ADR 365 §3 — the deciding readers of the wake ledger stay on rows THIS machine minted.
 *
 * The six wake verbs now cross the wire as `ledger` events so `musterd report` can count a team's
 * whole wake economy (ADR 365 §1). But those same rows are the rate policy's state (ADR 131 §4):
 * the hourly cap, the attempt cap, ADR 262's re-spend breaker and ADR 357's `workspace_readable`
 * all COUNT them. Folding a peer's rows into those counts would make wake caps team-wide — a
 * decision crossing the wire, which is residence 3, and not this ADR's to make. So every deciding
 * read carries this predicate and behaves exactly as it did before replication existed.
 *
 * `''` is a row minted here before the stamp existed (every pre-v58 row, and any row whose stamp
 * failed); the subquery is this daemon's node id for the team, absent on a machine that has never
 * enrolled — which is then simply the `''` case. A folded row matches neither.
 *
 * Falsifier: fold a peer's `residency.woke` rows past the hourly cap and poll for a wake here — it
 * must still be ordered. `residency.test.ts` "ignores a peer machine's wake rows" pins it; drop the
 * predicate from `wakesSince` and that case fails.
 */
export const MINTED_HERE = `AND origin_node IN ('', COALESCE((SELECT node_id FROM local_node l WHERE l.team_id = audit.team_id), ''))`;

/**
 * ADR 306: has the lane moved since the last successful wake on this edge? A continuation wake that
 * changed nothing does not buy the next one (ADR 247 — progress is not an outcome; ADR 250 §2 — no
 * heartbeat that burns spend while nothing changed). No prior woke ⇒ nothing to have stalled since,
 * so the first firing is always permitted. ADR 661: the owner's away running out after that woke
 * counts as movement, once.
 */
export async function laneMovedSinceLastWoke(
  db: Driver,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
  ownerAvailability: Availability | null,
  now: number,
): Promise<boolean> {
  const last = await db.get<{ ts: number }>(
    `SELECT ts FROM audit
        WHERE team_id = ? AND action = 'residency.woke'
          AND json_extract(detail, '$.lane_id') = ? ${MINTED_HERE}
          AND json_extract(detail, '$.edge') = ?
        ORDER BY ts DESC, id DESC LIMIT 1`,
    [teamId, laneId, edge],
  );
  if (!last) return true;
  const lane = await db.get<{ updated_at: number }>(
    'SELECT updated_at FROM lanes WHERE team_id = ? AND id = ?',
    [teamId, laneId],
  );
  if (!lane) return false;
  if (lane.updated_at > last.ts) return true;
  // ADR 661: an away that ran out after the last wake is the owner coming back. A wake inside the
  // away moved nothing because the seat was standing down, so the lane re-arms once, at `until`.
  // The next woke lands after `until`, and the rule above governs again.
  const back = awayEnd(ownerAvailability);
  return back !== null && back > last.ts && back <= now;
}

/** The `until` of an away, or null for any other availability. */
function awayEnd(a: Availability | null): number | null {
  return a?.status === 'away' ? (a.until ?? null) : null;
}

/**
 * ADR 664: a claimed lane on an enrolled seat that ADR 306 §2 has stopped waking. Its last
 * `dispatch_continuation` woke moved nothing, nothing has moved it since, and no ADR 661 re-arm is
 * pending. Advisory like `stale_acceptance`: owner null, never a directed wake. Reads rows this
 * daemon minted, so a joiner shows it only for wakes it leased.
 */
export async function stalledContinuationWarning(
  db: Driver,
  teamId: string,
  lane: Lane,
  now: number,
): Promise<LaneWarning | null> {
  if ((lane.state !== 'claimed' && lane.state !== 'active') || lane.owner_seat === null)
    return null;
  const owner = await db.get<{ id: string; availability: string | null }>(
    'SELECT id, availability FROM members WHERE team_id = ? AND name = ?',
    [teamId, lane.owner_seat],
  );
  if (!owner) return null;
  const enrolled = await db.get<{ n: number }>(
    'SELECT 1 AS n FROM residency WHERE team_id = ? AND member_id = ?',
    [teamId, owner.id],
  );
  if (!enrolled) return null;
  const last = await db.get<{ ts: number }>(
    `SELECT ts FROM audit
        WHERE team_id = ? AND action = 'residency.woke'
          AND json_extract(detail, '$.lane_id') = ? ${MINTED_HERE}
          AND json_extract(detail, '$.edge') = 'dispatch_continuation'
        ORDER BY ts DESC, id DESC LIMIT 1`,
    [teamId, lane.id],
  );
  if (!last) return null;
  const availability = parseAvailability(owner.availability);
  if (await laneMovedSinceLastWoke(db, teamId, lane.id, 'dispatch_continuation', availability, now))
    return null;
  // An away still running that began before the wake re-arms at `until` (ADR 661): not stalled.
  const back = awayEnd(availability);
  if (back !== null && back > last.ts) return null;
  const hours = Math.floor((now - last.ts) / 3_600_000);
  return {
    kind: 'stalled_continuation',
    subject: lane.id,
    with: lane.id,
    owner: null,
    detail:
      `no wake due: the last continuation wake for ${lane.owner_seat} (${hours}h ago) moved ` +
      `nothing, and nothing has moved the lane since — it waits until the lane changes or ` +
      `someone steers ${lane.owner_seat}`,
  };
}

function parseAvailability(raw: string | null): Availability | null {
  if (!raw) return null;
  try {
    return AvailabilitySchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}
