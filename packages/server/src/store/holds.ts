/**
 * Holds (ADR 516, SPEC A.15): a time-bounded Team rule only a human admin sets or lifts.
 *
 * Active is DERIVED — `lifted_at IS NULL AND now < expires_at` — so there is no status column and no
 * timer: the moment `expires_at` passes, every reader stops seeing the hold, and no seat holds a copy
 * that outlives it. Rows are never deleted; the table is the history of every rule the Team was under.
 *
 * Holds are hub-authoritative like policy (ADR 367): the hub writes the row and its replicated event
 * in one transaction, and joiners learn by fold (`projectHoldEvent`). The hold id is minted once, on
 * the hub, and crosses verbatim, which is what makes the fold idempotent on every node.
 */
import {
  HOLD_MAX_MS,
  HoldSchema,
  type Hold,
  type HoldProvenance,
  type SetHoldBody,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendReplicatedEvent } from './audit.js';

interface HoldRow {
  id: string;
  team_id: string;
  effect: string;
  reason: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  lifted_at: number | null;
  lifted_by: string | null;
}

const COLUMNS = 'id, effect, reason, created_by, created_at, expires_at, lifted_at, lifted_by';

function toHold(row: HoldRow): Hold {
  return HoldSchema.parse({
    id: row.id,
    effect: row.effect,
    reason: row.reason,
    created_by: row.created_by,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    lifted_at: row.lifted_at === null ? null : Number(row.lifted_at),
    lifted_by: row.lifted_by,
  });
}

/**
 * The end time a set body asks for, checked against the cap. `until` is absolute, `for_ms` relative
 * to `now`; both must land in the future and within {@link HOLD_MAX_MS}.
 */
export function holdExpiry(body: SetHoldBody, now: number): number {
  const expires = body.until ?? now + body.for_ms!;
  if (expires <= now) throw new MusterdError('validation', 'a hold must end in the future');
  if (expires - now > HOLD_MAX_MS) {
    throw new MusterdError(
      'validation',
      'a hold is capped at 12h — a longer freeze is a new hold, set deliberately',
    );
  }
  return expires;
}

/** The hold an accepted proposal already activated, if any (its `hold.set` audit row). */
export async function holdForProposal(
  db: Driver,
  teamId: string,
  askId: string,
): Promise<string | null> {
  const row = await db.get<{ target: string }>(
    `SELECT target FROM audit WHERE team_id = ? AND action = 'hold.set'
       AND json_extract(detail, '$.proposal_ask') = ? LIMIT 1`,
    [teamId, askId],
  );
  return row?.target ?? null;
}

/** Active holds, soonest end first. */
export async function listActiveHolds(db: Driver, teamId: string, now: number): Promise<Hold[]> {
  const rows = await db.all<HoldRow>(
    `SELECT ${COLUMNS} FROM holds WHERE team_id = ? AND lifted_at IS NULL AND expires_at > ?
       ORDER BY expires_at ASC, id ASC`,
    [teamId, now],
  );
  return rows.map(toHold);
}

/** Every hold the Team has had, newest first — `GET /holds?all=1`. */
export async function listAllHolds(db: Driver, teamId: string): Promise<Hold[]> {
  const rows = await db.all<HoldRow>(
    `SELECT ${COLUMNS} FROM holds WHERE team_id = ? ORDER BY created_at DESC, id DESC`,
    [teamId],
  );
  return rows.map(toHold);
}

/** One hold by id, active or not — ADR 522's claim check reads its real state. */
export async function getHoldById(db: Driver, teamId: string, id: string): Promise<Hold | null> {
  const row = await db.get<HoldRow>(`SELECT ${COLUMNS} FROM holds WHERE team_id = ? AND id = ?`, [
    teamId,
    id,
  ]);
  return row ? toHold(row) : null;
}

/**
 * Set a hold (hub-side). The caller has already authorized `actor` as a human admin. One
 * transaction: the row and its replicated `hold.set` event, whose `detail` carries the whole hold so
 * a joiner's fold can project it without a second read.
 */
export async function setHold(
  db: Driver,
  teamId: string,
  actor: string,
  body: SetHoldBody,
  now: number = Date.now(),
  /** Increment 3: the accepted proposal this hold comes from. One proposal yields one hold. */
  provenance?: HoldProvenance,
): Promise<Hold> {
  if (provenance && (await holdForProposal(db, teamId, provenance.proposal_ask))) {
    throw new MusterdError(
      'conflict',
      `proposal ${provenance.proposal_ask} already activated a hold`,
    );
  }
  const expires_at = holdExpiry(body, now);
  const hold: Hold = {
    id: ulid(now),
    effect: body.effect,
    reason: body.reason,
    created_by: actor,
    created_at: now,
    expires_at,
    lifted_at: null,
    lifted_by: null,
  };
  await db.tx(async (t) => {
    await insertHold(t, teamId, hold);
    await appendReplicatedEvent(t, teamId, {
      actor,
      action: 'hold.set',
      target: hold.id,
      result: 'allow',
      detail: { hold, ...(provenance ?? {}) },
    });
  });
  return hold;
}

/**
 * Lift an active hold early (hub-side). An unknown, already-lifted or already-ended hold is
 * `not_found`: there is nothing in force to lift, and saying "lifted" would be a second fact about a
 * rule that had already stopped.
 */
export async function liftHold(
  db: Driver,
  teamId: string,
  actor: string,
  id: string,
  now: number = Date.now(),
): Promise<Hold> {
  return db.tx(async (t) => {
    const current = await getHoldById(t, teamId, id);
    if (!current || current.lifted_at !== null || current.expires_at <= now) {
      throw new MusterdError('not_found', `no active hold "${id}"`);
    }
    await markLifted(t, teamId, id, actor, now);
    await appendReplicatedEvent(t, teamId, {
      actor,
      action: 'hold.lifted',
      target: id,
      result: 'allow',
      detail: { id, lifted_at: now, lifted_by: actor },
    });
    return { ...current, lifted_at: now, lifted_by: actor };
  });
}

async function insertHold(db: Driver, teamId: string, hold: Hold): Promise<void> {
  await db.run(
    `INSERT INTO holds (id, team_id, effect, reason, created_by, created_at, expires_at, lifted_at, lifted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    [
      hold.id,
      teamId,
      hold.effect,
      hold.reason,
      hold.created_by,
      hold.created_at,
      hold.expires_at,
      hold.lifted_at,
      hold.lifted_by,
    ],
  );
}

async function markLifted(
  db: Driver,
  teamId: string,
  id: string,
  actor: string,
  at: number,
): Promise<void> {
  await db.run(
    'UPDATE holds SET lifted_at = ?, lifted_by = ? WHERE team_id = ? AND id = ? AND lifted_at IS NULL',
    [at, actor, teamId, id],
  );
}

/**
 * Project a replicated `hold.*` event on a joiner (ADR 516 §4). Idempotent: the insert is keyed on
 * the hub's id and a lift only stamps an unlifted row. `'unknown'` for a verb or a detail this build
 * cannot read — the fold then stops as `unknown_policy_event`, the policy kind's rule.
 */
export async function projectHoldEvent(
  db: Driver,
  teamId: string,
  action: string,
  detail: Record<string, unknown> | null | undefined,
): Promise<'applied' | 'unknown'> {
  if (action === 'hold.set') {
    const parsed = HoldSchema.safeParse(detail?.['hold']);
    if (!parsed.success) return 'unknown';
    await insertHold(db, teamId, parsed.data);
    return 'applied';
  }
  if (action === 'hold.lifted') {
    const id = detail?.['id'];
    const at = detail?.['lifted_at'];
    const by = detail?.['lifted_by'];
    if (typeof id !== 'string' || typeof at !== 'number' || typeof by !== 'string') {
      return 'unknown';
    }
    await markLifted(db, teamId, id, by, at);
    return 'applied';
  }
  return 'unknown';
}
