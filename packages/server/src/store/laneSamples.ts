import {
  LANE_SAMPLES_SERVED,
  type Lane,
  type LaneSample,
  type SampleInput,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendLaneEventRequired } from './audit.js';

/**
 * ADR 673 §2: a metric lane's daily samples — one row per lane per day in `lane_samples`, a later
 * write for the day replacing the earlier one. Every write is one `lane.sample_recorded` row
 * carrying the new value and the one it replaced; that row is also what the sync fold replays.
 */

interface SampleRow {
  lane_id: string;
  day: string;
  value: number;
  n: number;
  by_name: string;
  at: number;
}

const toSample = (r: SampleRow): LaneSample => ({
  day: r.day,
  value: Number(r.value),
  n: Number(r.n),
  by: r.by_name,
  at: Number(r.at),
});

/** Insert or replace one day's sample. Shared by the endpoint and the fold, so both write alike. */
export async function upsertSample(
  db: Driver,
  teamId: string,
  laneId: string,
  sample: LaneSample,
): Promise<void> {
  await db.run(
    `INSERT INTO lane_samples (team_id, lane_id, day, value, n, by_name, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, lane_id, day) DO UPDATE SET
         value = excluded.value, n = excluded.n, by_name = excluded.by_name, at = excluded.at`,
    [teamId, laneId, sample.day, sample.value, sample.n, sample.by, sample.at],
  );
}

/**
 * Record a sample against `lane`. Refused (`bad_request`) when the lane measures nothing, and
 * with 409 when it is done or abandoned: a closed read takes no more numbers.
 */
export async function recordSample(
  db: Driver,
  teamId: string,
  lane: Lane,
  input: SampleInput,
  by: string,
  now: number = Date.now(),
): Promise<{ sample: LaneSample; replaced: LaneSample | null }> {
  if (!lane.metric)
    throw new MusterdError(
      'bad_request',
      `lane "${lane.id}" has no metric — declare one first (lane_update {metric: …}) (ADR 673)`,
    );
  if (lane.state === 'done' || lane.state === 'abandoned')
    throw new MusterdError('conflict', `lane "${lane.id}" is ${lane.state}; it takes no samples`);
  const sample: LaneSample = { ...input, by, at: now };
  return db.tx(async (t) => {
    const prior = await t.get<SampleRow>(
      'SELECT * FROM lane_samples WHERE team_id = ? AND lane_id = ? AND day = ?',
      [teamId, lane.id, input.day],
    );
    await upsertSample(t, teamId, lane.id, sample);
    const replaced = prior ? toSample(prior) : null;
    await appendLaneEventRequired(t, teamId, {
      actor: by,
      action: 'lane.sample_recorded',
      target: lane.id,
      result: 'allow',
      detail: {
        lane: lane.id,
        ...sample,
        replaced: replaced ? { value: replaced.value, n: replaced.n, by: replaced.by } : null,
      },
    });
    return { sample, replaced };
  });
}

/** Delete one day's sample. Shared by {@link removeRecordedSample} and the fold. */
export async function deleteSample(
  db: Driver,
  teamId: string,
  laneId: string,
  day: string,
): Promise<void> {
  await db.run('DELETE FROM lane_samples WHERE team_id = ? AND lane_id = ? AND day = ?', [
    teamId,
    laneId,
    day,
  ]);
}

/**
 * ADR 715: take back a day's sample that nothing now measures (a derived lane whose scope changed
 * after the day was written). One `lane.sample_removed` row carries what was removed, so the log
 * still says what the chart once showed; a peer folding it deletes the same row. Nothing to remove
 * is not an error.
 */
export async function removeRecordedSample(
  db: Driver,
  teamId: string,
  laneId: string,
  day: string,
  by: string,
  now: number = Date.now(),
): Promise<LaneSample | null> {
  return db.tx(async (t) => {
    const prior = await t.get<SampleRow>(
      'SELECT * FROM lane_samples WHERE team_id = ? AND lane_id = ? AND day = ?',
      [teamId, laneId, day],
    );
    if (!prior) return null;
    await deleteSample(t, teamId, laneId, day);
    const removed = toSample(prior);
    await appendLaneEventRequired(t, teamId, {
      actor: by,
      action: 'lane.sample_removed',
      target: laneId,
      result: 'allow',
      detail: {
        lane: laneId,
        day,
        by,
        at: now,
        removed: { value: removed.value, n: removed.n, by: removed.by },
      },
    });
    return removed;
  });
}

/**
 * The newest {@link LANE_SAMPLES_SERVED} samples per metric lane, oldest first, attached to the
 * lanes that declare a metric. One query for the whole set; lanes without a metric are untouched.
 */
export async function withSamples(db: Driver, teamId: string, lanes: Lane[]): Promise<Lane[]> {
  const ids = lanes.filter((l) => l.metric).map((l) => l.id);
  if (ids.length === 0) return lanes;
  const rows = await db.all<SampleRow>(
    `SELECT * FROM lane_samples WHERE team_id = ? AND lane_id IN (${ids.map(() => '?').join(',')})
       ORDER BY lane_id, day DESC`,
    [teamId, ...ids],
  );
  const byLane = new Map<string, LaneSample[]>();
  for (const r of rows) {
    const list = byLane.get(r.lane_id) ?? [];
    if (list.length < LANE_SAMPLES_SERVED) list.push(toSample(r));
    byLane.set(r.lane_id, list);
  }
  return lanes.map((l) => (l.metric ? { ...l, samples: (byLane.get(l.id) ?? []).reverse() } : l));
}
