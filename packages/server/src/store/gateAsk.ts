import { answerAuthority } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';

/**
 * Gate B (ADR 150 — structural inducement) ask-lifecycle reads. The `costly-action` gate's "deny **is**
 * emit" keys everything on the **fingerprint** (a hash of the class + normalized action, never the raw
 * command): a gate-emitted ask carries `meta.gate = { class, fingerprint }`, and these two pure reads let
 * `gateB` (1) converge every re-attempt of the same action onto ONE open ask instead of spamming one per
 * attempt, and (2) release only on a **human**'s accept referencing that ask. No timer, no new state —
 * the daemon reads the durable message log the ADR 147 ask stream already writes.
 */

/**
 * The gate-ask for a fingerprint, if one has been raised: the newest `ask` message carrying
 * `meta.gate.fingerprint`. Answer state (accept/decline) is a separate read — this is the dedup anchor
 * *and* the release re-check's target. Mirrors `hasInterruptRaised`'s `json_extract` convergence, but on
 * the message row (where `meta.gate` is persisted) so one query feeds both. Best-effort: a read error
 * degrades to "none raised" (at worst one extra ask), never a gate on the decision.
 */
export async function findGateAsk(
  db: Driver,
  teamId: string,
  fingerprint: string,
): Promise<{ id: string; ts: number } | null> {
  try {
    const row = await db.get<{ id: string; ts: number }>(
      `SELECT id, ts FROM messages
          WHERE team_id = ? AND act = 'ask'
            AND json_extract(meta, '$.gate.fingerprint') = ?
          ORDER BY ts DESC LIMIT 1`,
      [teamId, fingerprint],
    );
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * A **human** seat's accept/decline naming this ask via `meta.in_reply_to` (ADR 149's answer shape),
 * earliest first — the release signal. Human-only by the `members.kind = 'human'` join: ADR 150 defers
 * "only an *admin's* accept counts" (gated on `multi-human-admin`) but requires a human accept — an
 * agent's accept never releases a gate. Best-effort like `findGateAsk`.
 */
export async function gateAskHumanAnswer(
  db: Driver,
  teamId: string,
  askId: string,
): Promise<{ act: 'accept' | 'decline'; by: string; ts: number } | null> {
  try {
    // Earliest first, and the first one that is AUTHORITY wins (ADR 623 §4): an answer that came
    // through a channel is advisory and never releases a gate, so it is skipped, not honoured.
    const rows = await db.all<{ act: string; by: string; ts: number; meta: string | null }>(
      `SELECT m.act AS act, mem.name AS by, m.ts AS ts, m.meta AS meta
           FROM messages m JOIN members mem ON mem.id = m.from_member
          WHERE m.team_id = ? AND m.act IN ('accept', 'decline')
            AND mem.kind = 'human'
            AND m.in_reply_to = ?
          ORDER BY m.ts ASC`,
      [teamId, askId],
    );
    for (const row of rows) {
      let meta: Record<string, unknown> | null = null;
      try {
        meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
      } catch {
        // Unreadable meta cannot prove it is not a channel answer: fail closed, skip it.
        continue;
      }
      if (answerAuthority(null, meta) !== 'authority') continue;
      return { act: row.act as 'accept' | 'decline', by: row.by, ts: row.ts };
    }
    return null;
  } catch {
    return null;
  }
}
