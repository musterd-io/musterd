import type { Envelope } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { rowToEnvelope } from './messages.js';
import type { MessageRow } from './rows.js';

/**
 * Turn message rows into Envelopes, asking for every DISTINCT member's name in one statement.
 *
 * Every call site used to do this inline, one `getMemberById` per row per party — thousands of
 * statements to learn tens of names (measured: 800 statements for 31 names on revive). The rows in a
 * window come from a team with tens of members, so the per-row shape was always asking the same few
 * questions over and over.
 *
 * It is worth a named helper rather than a local memo because of WHERE these hydrations run. The
 * daemon is single-threaded over synchronous better-sqlite3, so time any handler holds is time
 * `/health` waits — and the guardian reports `daemon_down` when `/health` misses its timeout. Four of
 * those alarms were false for exactly this reason. `/inbox/interrupt-check` is the sharpest case: a
 * PostToolUse hook calls it at every tool boundary of every live agent, and it is documented sub-50ms.
 *
 * The name map lives for one call. Membership cannot change underneath a single derivation — these all
 * read a window that was already fetched — so there is no cache to invalidate and no staleness to
 * reason about. A missing member row yields `'?'` for a sender and `null` for a recipient, which is
 * what the per-row hydration did.
 */
export async function rowsToEnvelopes(
  db: Driver,
  teamSlug: string,
  rows: MessageRow[],
): Promise<Envelope[]> {
  // Every distinct party in ONE statement (lane 01M46RPQ94): a lookup per member is a transaction
  // per member on Postgres, and Cloud load run 12 (2026-10-05) put a `/report` derivation on a
  // 150-member team at 202 of them.
  const ids = [
    ...new Set(rows.flatMap((r) => (r.to_member ? [r.from_member, r.to_member] : [r.from_member]))),
  ];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const found = await db.all<{ id: string; name: string }>(
      `SELECT id, name FROM members WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    for (const m of found) names.set(m.id, m.name);
  }
  return rows.map((r) =>
    rowToEnvelope(
      r,
      teamSlug,
      names.get(r.from_member) ?? '?',
      r.to_member ? (names.get(r.to_member) ?? null) : null,
    ),
  );
}
