import {
  ASK_WITHHOLD_MAX_MS,
  AskWithholdSchema,
  askWithholds,
  type ActiveWithhold,
  type AskSpecies,
  type AskTier,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { gateAskHumanAnswer } from './gateAsk.js';

/**
 * ADR 801: the asking seat's open withholds, derived from the message log on every read — no table, no
 * timer, like ADR 516's holds. A withhold is a blocking `approve` ask the seat raised itself, younger
 * than {@link ASK_WITHHOLD_MAX_MS}, with no human accept and no withdrawal (a `resolve` the seat sent
 * on the ask's thread before any human answered). A human decline keeps it, marked `declined` (§4),
 * and the seat's own withdrawal after a decline does not lift it.
 *
 * A team with no human member withholds nothing: nobody there can release one.
 *
 * Asks the daemon or a gate composes for structured flows are not the seat's own approval request and
 * never withhold: a lane review (ADR 202/603, often blocking for a human verdict), a Gate B ask (that
 * gate already withholds its action, ADR 150), a hold, a policy review, a handoff, a question.
 */
const STRUCTURED_ASK_KEYS = [
  'lane_review',
  'gate',
  'hold',
  'policy_review',
  'lane_handoff',
  'question',
] as const;

/** How many of the seat's recent asks one read looks at; a seat with more open blocking asks than
 *  this is already stuck for other reasons, and the bound keeps the per-call read constant. */
const SCAN_LIMIT = 20;

export async function openWithholds(
  db: Driver,
  teamId: string,
  memberId: string,
  now: number,
): Promise<ActiveWithhold[]> {
  // ADR 801 (amended 2026-11-04, lazara's review): only a human can release a withhold, so a team with
  // no human member — a CooperBench pair team — withholds nothing. Holding there would freeze the
  // seat until the 12h cap with nobody able to answer; the ask contract's STRAND branch still applies.
  const human = await db.get<{ one: number }>(
    `SELECT 1 AS one FROM members WHERE team_id = ? AND kind = 'human' LIMIT 1`,
    [teamId],
  );
  if (!human) return [];
  const rows = await db.all<{ id: string; ts: number; meta: string | null }>(
    `SELECT id, ts, meta FROM messages
        WHERE team_id = ? AND from_member = ? AND act = 'ask' AND ts > ?
          AND json_extract(meta, '$.species') = 'approve'
          AND json_extract(meta, '$.tier') = 'blocking'
        ORDER BY ts DESC LIMIT ${SCAN_LIMIT}`,
    [teamId, memberId, now - ASK_WITHHOLD_MAX_MS],
  );
  const out: ActiveWithhold[] = [];
  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    } catch {
      continue;
    }
    if (STRUCTURED_ASK_KEYS.some((k) => meta[k] !== undefined)) continue;
    if (!askWithholds(meta['species'] as AskSpecies, meta['tier'] as AskTier)) continue;
    const answer = await gateAskHumanAnswer(db, teamId, row.id);
    if (answer?.act === 'accept') continue;
    // A withdrawal lifts the withhold only while no human has answered: once a human declined, the
    // seat cannot undo the decline by resolving its own ask (security review, 2026-11-04).
    if (!answer) {
      const withdrawn = await db.get<{ one: number }>(
        `SELECT 1 AS one FROM messages
            WHERE team_id = ? AND from_member = ? AND act = 'resolve' AND thread_id = ? LIMIT 1`,
        [teamId, memberId, row.id],
      );
      if (withdrawn) continue;
    }
    const scoped = AskWithholdSchema.safeParse(meta['withhold']);
    out.push({
      ask_id: row.id,
      commands: scoped.success ? (scoped.data.commands ?? []) : [],
      paths: scoped.success ? (scoped.data.paths ?? []) : [],
      seat_wide: !scoped.success,
      declined: answer?.act === 'decline',
      expires_at: Number(row.ts) + ASK_WITHHOLD_MAX_MS,
    });
  }
  return out;
}
