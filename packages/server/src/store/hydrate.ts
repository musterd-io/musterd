import type { Envelope } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { getMemberById } from './members.js';
import { rowToEnvelope } from './messages.js';
import type { MessageRow } from './rows.js';

/**
 * Turn message rows into Envelopes, asking each DISTINCT member for its name once.
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
 * The memo lives for one call. Membership cannot change underneath a single derivation — these all
 * read a window that was already fetched — so there is no cache to invalidate and no staleness to
 * reason about. A missing member row yields `'?'` for a sender and `null` for a recipient, which is
 * what the per-row hydration did.
 */
export async function rowsToEnvelopes(
  db: Driver,
  teamSlug: string,
  rows: MessageRow[],
): Promise<Envelope[]> {
  // Memoise the LOOKUP, not its result: the rows hydrate concurrently, so a memo filled after the
  // first await would let every row of one sender start its own read before any of them landed.
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = async (id: string): Promise<string | undefined> => {
    let p = names.get(id);
    if (!p) {
      p = getMemberById(db, id).then((m) => m?.name);
      names.set(id, p);
    }
    return p;
  };
  return Promise.all(
    rows.map(async (r) =>
      rowToEnvelope(
        r,
        teamSlug,
        (await nameOf(r.from_member)) ?? '?',
        r.to_member ? ((await nameOf(r.to_member)) ?? null) : null,
      ),
    ),
  );
}
