import type { Envelope } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { rowsToEnvelopes } from './hydrate.js';
import { type Deferral, deferrals, listTeamMessages, raisedDeferrals } from './messages.js';
import type { MemberRow } from './rows.js';

/** Matches the inbox/wake reads' bound (ADR 211 §3). A deferral older than this stops being tracked,
 *  which degrades to today's behaviour (the act is simply unread) rather than to a wrong answer. */
export const DEFERRAL_SCAN_LIMIT = 2000;

/**
 * The deferral fold (ADR 211): what this seat has postponed, and which of those have been raised.
 *
 * The window is the PARTY-SCOPED TEAM TIMELINE, not the inbox — `listInbox` excludes the member's own
 * sends and a deferring `wait` IS the member's own send, so folding over the inbox would find no
 * deferrals at all.
 *
 * WHY THE TWO-STEP. `deferrals` reads exactly one shape: the seat's own `wait` acts. `raisedDeferrals`
 * is the one that needs the whole window (every act on the deferred subjects, and their threads) — and
 * it is dead weight unless something is actually held. Hydrating 2000 rows into Envelopes to discover
 * that nothing was deferred cost 26ms on every inbox read, on the request path of a single-threaded
 * daemon whose `/health` probe the guardian reads as liveness. So the narrow question is asked first,
 * against the same window, and the full hydration happens only on the rare path that needs it.
 *
 * Both steps read the same rows in the same order under the same limit, so the answer is identical to
 * hydrating unconditionally — only the cost of reaching it changes.
 *
 * `own` — the seat's own sends within the window — is returned rather than recomputed because the
 * inbox read folds a second answer off exactly that subset (which asks it has already replied to, by
 * `meta.in_reply_to`). One narrow hydration, two folds; the caller never has to reach for the window.
 */
type Fold = { held: Map<string, Deferral>; raised: Set<string>; own: Envelope[] };

/**
 * Reuse between messages (SQLite). The fold reads only `messages` (plus member names, which never
 * change), and `messages` is insert-only outside migrations, so its result holds until a row is added.
 * `MAX(rowid)` is that marker at O(1), whichever path inserted (a send or the sync fold). It is read
 * BEFORE the fold, so a row landing mid-fold leaves the entry keyed to an already-stale marker: never
 * served, only recomputed. Postgres has no rowid, and the fold is not on its event loop, so it is
 * computed fresh there. GET /inbox ran this on every read: ~350 reads per 10 minutes on the hub
 * against ~15 new messages, ~40ms each (2026-10-12). Callers treat the result as read-only.
 */
const foldMemo = new WeakMap<Driver, Map<string, { mark: number; fold: Fold }>>();

export async function deferralFold(
  db: Driver,
  teamSlug: string,
  member: MemberRow,
  limit: number = DEFERRAL_SCAN_LIMIT,
): Promise<Fold> {
  if (db.dialect !== 'sqlite') return await computeFold(db, teamSlug, member, limit);
  const mark = Number(
    (await db.get<{ mark: number | null }>('SELECT MAX(rowid) AS mark FROM messages'))?.mark ?? 0,
  );
  let memo = foldMemo.get(db);
  if (!memo) foldMemo.set(db, (memo = new Map()));
  const key = `${member.id}\0${teamSlug}\0${limit}`;
  const hit = memo.get(key);
  if (hit && hit.mark === mark) return hit.fold;
  const fold = await computeFold(db, teamSlug, member, limit);
  memo.set(key, { mark, fold });
  return fold;
}

async function computeFold(
  db: Driver,
  teamSlug: string,
  member: MemberRow,
  limit: number,
): Promise<Fold> {
  const window = await listTeamMessages(db, member.team_id, { forMemberId: member.id, limit });
  const own = await rowsToEnvelopes(
    db,
    teamSlug,
    window.filter((r) => r.from_member === member.id),
  );
  const held = deferrals(own, member.name);
  if (held.size === 0) return { held, raised: new Set<string>(), own };
  return {
    held,
    raised: raisedDeferrals(await rowsToEnvelopes(db, teamSlug, window), member.name),
    own,
  };
}
