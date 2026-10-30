import { hostname } from 'node:os';
import {
  DeferUntilSchema,
  eligibleOf,
  idleRingable,
  isPrEvent,
  isQuestionAnswer,
  OBLIGATION_ACTS_ANY,
  OBLIGATION_ACTS_DIRECTED,
  PROTOCOL_VERSION,
  REVIEW_DISPUTE_VIA,
  type DeferUntil,
  type Envelope,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import {
  answeredByAnyoneSql,
  laneSettledSql,
  resolvedThreadSql,
  undischargedSql,
} from './discharge.js';
import type { MessageRow, MessageVisibility } from './rows.js';

/**
 * The sender's presence provenance at send time — the freshest non-held row (a resident socket's
 * heartbeat and the ambient touch both keep `last_seen_at` current). Stamped onto the message by
 * `insertMessage` itself, SERVER-derived by construction (there is no wire field), so a wake-born
 * session cannot masquerade as human-driven to escape the ADR 131 §4 ping-pong demotion.
 */
async function senderProvenance(db: Driver, memberId: string): Promise<string | null> {
  const row = await db.get<{ provenance: string | null }>(
    `SELECT provenance FROM presence
        WHERE member_id = ? AND held_until IS NULL
        ORDER BY last_seen_at DESC, created_at DESC LIMIT 1`,
    [memberId],
  );
  return row?.provenance ?? null;
}

/**
 * The team's own node, READ ONLY — `null` when nothing has minted one yet. For reads that must not
 * write (an anonymous roster GET, ADR 503 §4): `localNodeForTeam` lazily mints the row, and a
 * credential-free request must never be the thing that does so.
 */
export async function localNodeIfAny(
  db: Driver,
  teamId: string,
): Promise<{ id: string; label: string } | null> {
  return (
    (await db.get<{ id: string; label: string }>(
      `SELECT n.id, n.label FROM local_node l JOIN nodes n ON n.id = l.node_id WHERE l.team_id = ?`,
      [teamId],
    )) ?? null
  );
}

/**
 * This team's local node row (ADR 331 §Decision 1) — per (daemon, team), minted by migration v47
 * and lazily here for teams created after it.
 *
 * The `local_node` marker is the authority (v48, increment 3a), not `ORDER BY id LIMIT 1` as this
 * read once was. That ordering was correct only while enrollment did not exist and `nodes` held one
 * row per team; enrollment is exactly what adds remote rows, and one whose ULID sorted lower would
 * have taken over our stamp — holing our own sequence while writing numbers into a remote node's
 * that name events it never sent. Two sequences corrupted at once, which is the ambiguity between
 * loss and silence that ADR 331 exists to prevent.
 */
export async function localNodeForTeam(db: Driver, teamId: string): Promise<{ id: string }> {
  const marked = await db.get<{ node_id: string }>(
    'SELECT node_id FROM local_node WHERE team_id = ?',
    [teamId],
  );
  if (marked) return { id: marked.node_id };

  const id = ulid();
  await db.run('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)', [
    id,
    teamId,
    hostname(),
  ]);
  // Both writes or neither: `insertMessage` already holds the transaction, so a row minted without
  // its marker cannot survive to be re-minted on the next send.
  await db.run('INSERT INTO local_node (team_id, node_id) VALUES (?, ?)', [teamId, id]);
  return { id };
}

/**
 * Number a replicated row just before its transaction commits (ADR 531). The row goes in with
 * `origin_seq = 0`; this bumps the node's counter and writes the number onto it — and onto `row`,
 * so a caller reading it after `tx()` resolves sees the real value. The counter-row lock is taken
 * here, at commit, instead of at insert, so on Postgres it no longer spans the caller's request.
 * Still one transaction: a rollback burns no number, and the lock released by COMMIT keeps the
 * numbers in commit order (ADR 331's gapless, commit-ordered sequence).
 */
export function stampOriginAtCommit(
  t: Driver,
  table: 'messages' | 'audit',
  row: { id: string; origin_node: string; origin_seq: number },
): void {
  t.beforeCommit(async (c) => {
    // `next_seq` names the next value to assign, so the pre-increment value is this row's seq.
    const seq = (await c.get<{ seq: number }>(
      'UPDATE nodes SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq',
      [row.origin_node],
    ))!.seq;
    await c.run(`UPDATE ${table} SET origin_seq = ? WHERE id = ?`, [seq, row.id]);
    row.origin_seq = seq;
    for (const listener of replicatedCommitListeners) listener();
  });
}

const replicatedCommitListeners = new Set<() => void>();

/**
 * Be told when a replicated row (message, `lane.*`, `presence.*`, ledger, policy…) is about to
 * commit: this is the one place every such row is numbered, so a writer added tomorrow rings it
 * without opting in. The push loop listens so a lane or presence change leaves for the hub at once,
 * not at the next 60 s tick (realtime-sync step 4). It fires just BEFORE the commit — the listener
 * must defer (the push kick is debounced 200 ms) and must not throw; a rollback after it is a
 * spurious ring, which costs one empty pass. Returns the unsubscribe.
 */
export function onReplicatedCommit(listener: () => void): () => void {
  replicatedCommitListeners.add(listener);
  return () => void replicatedCommitListeners.delete(listener);
}

/** One sentence for a taken envelope id. Names no team: the primary key is global. */
export const DUPLICATE_ENVELOPE_ID = 'that envelope id is already in use';

/**
 * The global `messages.id` primary key, and nothing else. SQLite says
 * `UNIQUE constraint failed: messages.id` (`SQLITE_CONSTRAINT_PRIMARYKEY`). Postgres says sqlstate
 * `23505` on `messages_pkey`. Both drivers append `\n  in: <sql>` on the way out and keep the
 * driver error as `cause`, so either layer can carry the fact. A different constraint — a foreign
 * key on the same INSERT — must not match.
 */
function isDuplicateEnvelopeId(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (duplicateEnvelopeIdError(current)) return true;
    current = current.cause;
  }
  return false;
}

function duplicateEnvelopeIdError(err: Error): boolean {
  const code = 'code' in err && typeof err.code === 'string' ? err.code : '';
  const constraint =
    'constraint' in err && typeof err.constraint === 'string' ? err.constraint : '';
  if (code === '23505') {
    if (constraint) return constraint === 'messages_pkey';
    return /"messages_pkey"/.test(err.message);
  }
  return /UNIQUE constraint failed: messages\.id(?:\n|$)/.test(err.message);
}

/**
 * Insert an envelope into the append-only log. `toMemberId` set iff to.kind==='member'.
 *
 * Stamps `(origin_node, origin_seq)` (ADR 331): SERVER-derived like `from_provenance` — there is no
 * wire field, so a caller cannot supply an origin. The seq is assigned at commit (ADR 531,
 * {@link stampOriginAtCommit}), in the same transaction as the insert, so a throw — a replayed
 * envelope id's UNIQUE violation is the realistic one — burns no number and leaves no hole.
 *
 * That violation is `conflict` ({@link DUPLICATE_ENVELOPE_ID}). A raw driver error would tell a
 * caller that some team already holds the id. A foreign-key or check failure stays a driver error.
 */
export async function insertMessage(
  db: Driver,
  teamId: string,
  fromMemberId: string,
  toMemberId: string | null,
  env: Envelope,
  /**
   * `now` is the receipt clock the row is stamped with (`created_at`) — the position every read
   * cursor walks. Injected for the same reason `slowestInboxLagMs(db, now)` is: a fixture that
   * needs two rows in one millisecond, or one that arrives an hour after it was stamped, cannot
   * get either from a wall clock. Production callers leave it unset.
   */
  opts: { now?: number } = {},
): Promise<MessageRow> {
  return db.tx(async (t) => {
    const node = await localNodeForTeam(t, teamId);
    const row: MessageRow = {
      id: env.id,
      team_id: teamId,
      from_member: fromMemberId,
      to_kind: env.to.kind,
      to_member: toMemberId,
      act: env.act,
      body: env.body,
      thread_id: env.thread ?? null,
      meta: env.meta ? JSON.stringify(env.meta) : null,
      from_provenance: await senderProvenance(t, fromMemberId),
      origin_node: node.id,
      origin_seq: 0, // numbered at commit (ADR 531)
      ts: env.ts,
      created_at: opts.now ?? Date.now(),
    };
    try {
      await t.run(
        `INSERT INTO messages
           (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, from_provenance, origin_node, origin_seq, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.team_id,
          row.from_member,
          row.to_kind,
          row.to_member,
          row.act,
          row.body,
          row.thread_id,
          row.meta,
          row.from_provenance,
          row.origin_node,
          row.origin_seq,
          row.ts,
          row.created_at,
        ],
      );
    } catch (err) {
      if (isDuplicateEnvelopeId(err)) throw new MusterdError('conflict', DUPLICATE_ENVELOPE_ID);
      throw err;
    }
    stampOriginAtCommit(t, 'messages', row);
    return row;
  });
}

/** The `ts` of one message by id (loop-latency lookups, ADR 082 slice 3). Null when unknown. */
export async function getMessageTs(db: Driver, teamId: string, id: string): Promise<number | null> {
  const row = await db.get<{ ts: number }>('SELECT ts FROM messages WHERE team_id = ? AND id = ?', [
    teamId,
    id,
  ]);
  return row?.ts ?? null;
}

/**
 * Directed acts (request_help/handoff) not yet answered by an accept/decline whose
 * `meta.in_reply_to` names them **or closed by a resolve on their thread** — the open-loops gauge
 * (ADR 082 slice 3; resolve-exclusion added with ADR 090 so the gauge and the delivery ledger are
 * two derivations of one truth). Daemon-wide on purpose: a health signal sampled only when
 * telemetry is on.
 */
export async function countOpenLoops(db: Driver): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages m
        WHERE m.act IN ('request_help','handoff')
          ${undischargedSql('m', 'm.to_member')}`);
  return row?.n ?? 0;
}

/**
 * Open loops grouped by team slug (#207) — the per-team form of {@link countOpenLoops} for the
 * `open_loops` observable gauge, so a per-team/per-model coordination leaderboard can read the gauge
 * by `musterd.team`. Only teams with ≥1 open loop appear (a zero team is simply absent this cycle).
 */
export async function countOpenLoopsByTeam(db: Driver): Promise<{ team: string; count: number }[]> {
  return await db.all<{
    team: string;
    count: number;
  }>(`SELECT t.slug AS team, COUNT(*) AS count FROM messages m
         JOIN teams t ON t.id = m.team_id
        WHERE m.act IN ('request_help','handoff')
          ${undischargedSql('m', 'm.to_member')}
        GROUP BY t.slug`);
}

/**
 * Every position in here is in RECEIPT order — `messages.created_at`, this daemon's clock at insert
 * or fold — never the envelope's `ts`, which is the origin's clock and travels (ADR 335). A cursor
 * keyed on `ts` never showed an event that arrived after the seat last read but was stamped before
 * it (the ts-cursor defect, lane 01M1FAYTHQA881M35PDPXRTGM1). `cursorTs` and `since` are both
 * `created_at` values; the CLI pages with the envelope's `received_at`, which is this column.
 */
export interface InboxOpts {
  since?: number;
  unreadOnly?: boolean;
  cursorTs?: number;
  /**
   * The cursor row's id — the TIEBREAK this query already orders by, finally expressed in the
   * position that walks it. A read cursor is a `(created_at, id)` point, not a ts: two messages can share a
   * millisecond (musterd fan-out sends land sub-millisecond apart), and `created_at > cursorTs` drops the
   * one that ties. Not "shown late" — never shown, because the cursor only moves forward.
   * Omitted ⇒ the ts-only floor, which is correct whenever nothing ties.
   */
  cursorId?: string | null;
  /** The newest `limit` — the recent tail, for a caller that asked to see the latest few. */
  limit?: number;
  /**
   * The OLDEST `headLimit` — a PREFIX of the unbounded read, for bounding a response the caller did
   * not ask to have bounded.
   *
   * The distinction is load-bearing, which is why this is a separate option and not a flag on
   * `limit`. Truncating to the newest n and then letting the reader advance its cursor to the newest
   * row it received steps over everything that was cut — ADR 287's loss, arrived at from the other
   * direction. A prefix cannot do that: advancing to the last row seen leaves the remainder unread,
   * and catching up takes several reads and reaches every message in order.
   */
  headLimit?: number;
  /**
   * How many pinned obligations one bounded page may carry (ADR 429). Ignored without `limit` —
   * pinning is what keeps a waiting act out of a bounded page's blind spot, and an unbounded read
   * has none. Defaults to {@link PINNED_DEFAULT_LIMIT}.
   */
  pinnedLimit?: number;
  /**
   * Read these specific rows back, cursor and bounds ignored (lane 01M2JZYTAH).
   *
   * `team_inbox_check` clips a long body so one act cannot spend a whole reply's byte budget, and a
   * clip is only honest if the rest is reachable — before this, nothing on the read path named a
   * row: unreadOnly, since, limit and headLimit all select a WINDOW. This is not a cursor read. It
   * names acts the caller has already been shown, so it ignores the cursor (a clipped act is read
   * by the time anyone asks for it) and it moves nothing. Visibility is unchanged: the same team,
   * addressed-to-me-or-the-team, not-my-own-sends predicate as every other read here.
   */
  ids?: readonly string[];
}

/**
 * How many pinned obligations a bounded page carries (ADR 429).
 *
 * Generous on purpose. The number that actually decides what a seat SEES is the MCP's
 * `RESULT_BUDGET` — a byte budget, spent waiting-acts-first — and this is the wire bound beneath
 * it, so it wants to sit comfortably above anything a client will render and still be a ceiling.
 * 50 is ~4x the rows a 30k-char budget fits at this team's median body (592 chars) and caps the
 * pinned contribution at tens of KB instead of the measured 327.
 *
 * It is a ROW cap on the largest single contributor to a bounded reply, not a promise about reply
 * size; a caller that needs fewer names `pinnedLimit`.
 */
export const PINNED_DEFAULT_LIMIT = 50;

/**
 * A member's inbox: messages in their team addressed to them or to team/broadcast,
 * excluding their own sends. unreadOnly filters by the caller-supplied cursor position (receipt order).
 */
export async function listInbox(
  db: Driver,
  member: { id: string; team_id: string },
  opts: InboxOpts = {},
): Promise<MessageRow[]> {
  const params: unknown[] = [member.team_id, member.id, member.id];
  let where = `WHERE team_id = ?
       AND (to_member = ? OR to_kind IN ('team','broadcast'))
       AND from_member != ?`;
  // The id read short-circuits everything else: no cursor floor, no window, no pinning. An empty
  // list means "no rows", never "every row" — the caller asked for a named set and got it.
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    const holes = opts.ids.map(() => '?').join(',');
    return await db.all<MessageRow>(
      `SELECT * FROM messages ${where} AND id IN (${holes}) ORDER BY created_at ASC, id ASC`,
      [...params, ...opts.ids],
    );
  }
  if (opts.unreadOnly) {
    // Both floors apply when both are given: `cursorTs` is what the seat has already read, `since` is
    // how far a paging caller has walked. They are applied SEPARATELY rather than as `max(...)`,
    // because only one of them carries a tiebreak: the cursor is a `(created_at, id)` point and compares
    // as one, while `since` is a plain created_at and stays strict. Collapsing them to a single number is what
    // made the tied row unreachable — `max()` cannot express half a comparison. With no ties the two
    // forms select exactly the same rows.
    const cursorTs = opts.cursorTs ?? 0;
    if (opts.cursorId) {
      where += ' AND (created_at > ? OR (created_at = ? AND id > ?))';
      params.push(cursorTs, cursorTs, opts.cursorId);
    } else {
      where += ' AND created_at > ?';
      params.push(cursorTs);
    }
    if (typeof opts.since === 'number') {
      where += ' AND created_at > ?';
      params.push(opts.since);
    }
  } else if (typeof opts.since === 'number') {
    where += ' AND created_at > ?';
    params.push(opts.since);
  }
  // With a limit, take the NEWEST `limit` (DESC + LIMIT) then re-sort ascending for display — an
  // inbox is read most-recent-first, so a bounded view must keep the recent tail, not the oldest N
  // (the `ts ASC LIMIT` bug that returned the wrong end; mirrors listTeamMessages' backfill).
  if (opts.limit) {
    const newest = await db.all<MessageRow>(
      `SELECT * FROM (SELECT * FROM messages ${where} ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at ASC, id ASC`,
      [...params, opts.limit],
    );
    // MCP always sends `limit`, so the newest tail is team broadcasts and an old waiting handoff
    // never appears. The CLI banner reads with no limit and counts it. Pin action-needed unread
    // (request_help / ask / directed non-message) into the page. Directed `message` stays newest-N
    // so a mailbox of DMs does not explode the bound.
    if (!opts.unreadOnly) return newest;
    // The pinned set is the OBLIGATION class (ADR 429), bounded, and oldest-first.
    //
    // Obligation, not salience. This predicate used to read `to_kind = 'member' AND act NOT IN
    // ('message','resolve')` and its comment claimed to match the CLI banner's `isActionNeeded`. It
    // matched that predicate's SHAPE test and dropped the narrowing that makes it correct — the
    // banner counts through `openActionNeeded`, which also excludes a resolved thread and an act
    // this seat has already answered. The salience half was left doing a RETENTION job, and the two
    // tolerate error differently: a false positive in salience costs a row of screen, while a false
    // positive here is carried on every future read for as long as the act stays unread. Measured
    // 2026-09-21 on the laptop daemon: one seat's pinned set was 370 rows / 327 KB, of which 129
    // `accept`, 41 directed `status_update` and 13 `decline` — answers and reports, owed to nobody.
    //
    // Bounded, because `limit` was never true. It binds `newest` above; this SELECT carried no
    // LIMIT of its own, so `team_inbox_check {limit: 8}` on that seat returned 370 rows. Oldest
    // first: the obligation that has waited longest is the one a bounded page must not drop. What
    // the bound cuts is counted into `unread_remaining` by the caller like any other uncarried row,
    // so ADR 287 holds — the cursor still may not pass what was not rendered.
    //
    // Discharge is folded HERE rather than after marshalling. The handler computes `answered` /
    // `discharged` and ships them beside the rows so the client can un-pin, which is right for the
    // rendered view and too late for the wire: the row is already loaded and already sent. The
    // cheap half of that fold is expressible in SQL and is the bulk of it — an obligation answered
    // by an `accept`/`decline` from ANY seat (ADR 254: an eligible set is discharged by whoever
    // answers first) or replied to by this member at all. The app-level half (a closed lane, an act
    // already shown) stays where it is, and the response's id lists are unchanged.
    //
    // A `resolve` on the thread closes it too (ADR 025), and ADR 429 shipped without that clause —
    // a gap found while building ADR 432. `countOpenLoops` above has honoured thread-resolve since
    // ADR 090 and the CLI's `openActionNeeded` always has, so a resolved obligation was excluded
    // from the open-loops gauge and from the human's banner while STILL being pinned into every
    // bounded agent read: three readers, two of them agreeing and the newest one not. It is also
    // what makes a service seat's own discharge expressible — see ADR 432, where guardian resolves
    // the thread of an incident whose condition has cleared, being barred from `accept` by ADR 232.
    // The discharge shapes themselves are named ONCE, in `discharge.ts` (ADR 434): this read, the
    // open-loops gauge, the open directed ledger and the per-recipient ledger used to each spell
    // their own and disagreed on the recipient's in-thread reply — which is how a seat answers a
    // threaded steer, and how ryder was woken twice for one. The outer table stays UNALIASED so
    // `where` — built above and shared with every other read here — drops in unchanged; the
    // correlated subqueries name it `messages.id` explicitly, because an unqualified `id` inside
    // an EXISTS would resolve to the inner alias and silently match every row against itself.
    const pinnedAny = OBLIGATION_ACTS_ANY.map(() => '?').join(',');
    const pinnedDirected = OBLIGATION_ACTS_DIRECTED.map(() => '?').join(',');
    // ADR 505 §3: the one clause outside the act lists — a reviewer's `decline` that the daemon
    // stamped as a review dispute is owed an answer by the lane's owner, so it is pinned like any
    // obligation. Read off the server stamp (`isReviewDispute` is the in-memory twin), never the
    // act alone: a plain `decline` is still an answer, owed to nobody.
    //
    // ADR 614: the review dispute's discharge is narrower than ADR 434's four shapes, as SPEC §Disputes
    // says — it stays pinned until an `accept` or `decline` answers it (or its thread is resolved).
    // The owner's `message` reply (shape 3) clears every other obligation and used to clear this one
    // too, which let a concession or hold go unrecorded: 6 of 7 such replies in 30 days conceded.
    const pinned = await db.all<MessageRow>(
      `SELECT * FROM messages ${where}
           AND (
             ((act IN (${pinnedAny})
               OR (to_kind = 'member' AND act IN (${pinnedDirected})))
              ${undischargedSql('messages', '?')})
             OR (to_kind = 'member' AND act = 'decline'
                 AND json_extract(meta, '$.dispute.via') = ?
                 AND NOT EXISTS (${answeredByAnyoneSql('messages')})
                 AND NOT EXISTS (${resolvedThreadSql('messages')}))
           )
           ${laneSettledSql('messages')}
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      [
        ...params,
        ...OBLIGATION_ACTS_ANY,
        ...OBLIGATION_ACTS_DIRECTED,
        member.id,
        REVIEW_DISPUTE_VIA,
        opts.pinnedLimit ?? PINNED_DEFAULT_LIMIT,
      ],
    );
    if (pinned.length === 0) return newest;
    const byId = new Map<string, MessageRow>();
    for (const row of newest) byId.set(row.id, row);
    for (const row of pinned) byId.set(row.id, row);
    return [...byId.values()].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  // The prefix read: same order as the unbounded query, simply stopped early — except that it never
  // stops in the MIDDLE OF A TIE. A page cut between two rows sharing a millisecond cannot be walked
  // by a plain cursor: the next request asks for `created_at > last` and excludes every tied row, so
  // the remainder is stranded and the empty page reads as "caught up" (izzo's repro: 220 messages,
  // page one 200, page two 0, silently reaching 200). Completing the group instead of splitting it
  // makes `> last` exact again for EVERY caller — including one on an older client that has no way to
  // send a tiebreak — rather than adding a cursor field the lossy spelling still sits next to.
  //
  // The overshoot is the size of one tie group, so the bound is "about `headLimit`" rather than
  // exactly it. That is the deliberate trade: a response slightly over budget, or a silent
  // permanent hole in someone's history.
  if (opts.headLimit) {
    const head = await db.all<MessageRow>(
      `SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC LIMIT ?`,
      [...params, opts.headLimit],
    );
    if (head.length < opts.headLimit) return head;
    const last = head[head.length - 1]!;
    const tied = await db.all<MessageRow>(
      `SELECT * FROM messages ${where} AND created_at = ? AND id > ? ORDER BY id ASC`,
      [...params, last.created_at, last.id],
    );
    return tied.length > 0 ? [...head, ...tied] : head;
  }
  return await db.all<MessageRow>(
    `SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC`,
    [...params],
  );
}

/**
 * Total size of a member's inbox view (same visibility rule as {@link listInbox}, no cursor/limit) —
 * the denominator behind the CLI's "showing N of TOTAL" footer, so a bounded default can honestly say
 * how much history it elided. Cheap COUNT; unread is derived client-side from the cursor.
 */
/** Unread count by the caller-supplied cursor — what a bounded read needs in order to say how much
 *  it could not carry. Counting is not marshalling: this stays cheap on a deep backlog. */
export async function countUnread(
  db: Driver,
  member: { id: string; team_id: string },
  cursorTs: number,
  /** The cursor row's id — same `(created_at, id)` comparison {@link listInbox} makes, so the count and the
   *  listing can never disagree about a tied row. Without it this returns 0 while one still waits. */
  cursorId?: string | null,
): Promise<number> {
  if (cursorId) {
    const row = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
          WHERE team_id = ?
            AND (to_member = ? OR to_kind IN ('team','broadcast'))
            AND from_member != ?
            AND (created_at > ? OR (created_at = ? AND id > ?))`,
      [member.team_id, member.id, member.id, cursorTs, cursorTs, cursorId],
    );
    return row?.n ?? 0;
  }
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
        WHERE team_id = ?
          AND (to_member = ? OR to_kind IN ('team','broadcast'))
          AND from_member != ?
          AND created_at > ?`,
    [member.team_id, member.id, member.id, cursorTs],
  );
  return row?.n ?? 0;
}

export async function countInbox(
  db: Driver,
  member: { id: string; team_id: string },
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
        WHERE team_id = ?
          AND (to_member = ? OR to_kind IN ('team','broadcast'))
          AND from_member != ?`,
    [member.team_id, member.id, member.id],
  );
  return row?.n ?? 0;
}

/**
 * The interrupt-class acts still waiting for `me` in `messages` (ADR 088 §3) — the predicate the
 * `inbox --interrupt-check` probe runs at every tool boundary. Interrupt-class = **directed at me
 * or a `request_help` anyone can answer**, **not closed** by a `resolve` on its thread (ADR 025), and
 * either **flagged urgent** (`meta.urgent === true`, which the send path only ever leaves set when the
 * sender's `can_flag_urgent` passed the ADR 071 gate — so the capability check is already enforced
 * upstream) **or a `steer`** (ADR 103: a directive is interrupt-class by definition, so it raises the
 * line whether or not it is flagged urgent; `challenge`/`defer` stay behind the urgent tier) **or a
 * routed acceptance** (ADR 225: an `ask` carrying `meta.lane_review`). A terminal `resolve` never
 * interrupts.
 *
 * Obligation class (ADR 225 decision 1). Acceptance was structurally invisible here: it is an `ask`
 * at `tier:'standard'` and never carries `urgent`, so the free rail this predicate feeds skipped the
 * one act that blocks another seat's lane. Measured 2026-08-04 — five routed acceptances reached a
 * live, heads-down acceptor only when a human typed "check messages", and two produced a *crossed
 * handoff*: two seats re-assigning one lane twelve minutes apart, each on an inbox the other's act
 * had not reached. Both were alive throughout, so no wake addresses it; the gap yields contradiction,
 * not merely silence. `meta.lane_review` is the marker because the daemon sets it on the review
 * route — and `routeEnvelope` strips any client-supplied copy, so this cannot become an ungated
 * back door around the scarce `can_flag_urgent` flag (ADR 071).
 *
 * Obligations do NOT supersede each other, which is the one place they part company with steers: a
 * steer is a *direction* (newest wins, ADR 103), while an acceptance is an obligation against one
 * specific lane — a second one does not discharge the first, so every open acceptance stays on the
 * line.
 *
 * Steer supersession (ADR 103, borrowing ADR 017's newest-wins primitive applied to *direction*): only
 * the newest steer directed at me survives — older steers are superseded so a late-waking agent sees
 * only the current direction, never a contradictory stack. The winning-steer bar is taken over the
 * whole set (resolved or not) so resolving the current steer can't revive an older one, and the bar
 * can't collapse onto a stale steer. This is a pure read-side collapse, the mirror of how `resolve`
 * closes a thread above; no supersede column, no write-path side-effect.
 *
 * Newest first, so the caller names the most recent steer. Pure — reads envelopes, never the DB — so
 * it is trivially testable and the "daemon-composed, never the raw body" line (§4) is built from its
 * structured fields, not from `env.body`.
 */
export function pendingInterrupts(
  messages: Envelope[],
  me: string,
  /** ADR 225: admit obligation-class acts (a routed acceptance). **Off by default, and that default
   *  is load-bearing** — this predicate has two consumers with opposite needs. The ADR 088 interrupt
   *  line feeds a LIVE seat and is free, so it opts in. `claimWakeLeases` uses the same predicate to
   *  pick *immediate wakes*, which cost ADR 131 `wake_cost` and whose review path is deliberately
   *  gated on `loops.review` + `flow:auto` (ADR 191); admitting acceptance there would route a paid
   *  wake around its own policy gate. That the same predicate cannot serve both rails is precisely
   *  ADR 225's thesis — live and offline want different instruments — appearing in the code. */
  opts: {
    obligations?: boolean;
    huddles?: boolean;
    huddleOpens?: boolean;
    /** ADR 271 §4, built: the daemon's "this incident is now yours" notice (`meta.incident.routed_to`
     *  naming me) is a wake reason when the team's `incident.wake_on_route` is on. Paid rail only. */
    incidentRoutes?: boolean;
    /** ADR 271 §4, built: the daemon's "the red you parked behind is resolved" notice
     *  (`meta.incident.resolved_by`) is a wake reason when `incident.wake_on_resolve` is on. */
    incidentResolves?: boolean;
    /** ADR 558: the idle seam — admit every act `idleRingable` accepts (a plain directed ask,
     *  request_help, handoff). Live seam only, like `obligations`: never the paid wake rail. */
    directed?: boolean;
    /** ADR 773 §7: the answer to a question I asked — a wake reason on BOTH rails, because the
     *  seat ended its turn to wait for exactly this. ADR 779 §4: so is the PR watch telling me my
     *  lane's PR merged or went red. */
    answers?: boolean;
  } = {},
): Envelope[] {
  const resolved = new Set<string>();
  // ADR 254: an eligible-set act is discharged by the FIRST accept/decline naming it — for every
  // named seat at once. Built in the same pass as `resolved` and for the same reason: this predicate
  // is pure over envelopes (no `Database`), so it cannot call the ledger's `actAnswered`. It does not
  // need one — the discharging act is an envelope in the very list being scanned.
  const discharged = new Set<string>();
  // Clause 7(iv) of the doorbell contract: a steer has no accept/decline — the addressee's reply
  // IS the answer, whatever act it rides on. Only `me`'s own replies count here. An obligation is
  // discharged for every named seat by an accept/decline (any sender). A `wait` from me silences
  // the bell for me only (ADR 712): it does not decide the lane and it does not stand a
  // co-addressee down. A chat reply does not silence an obligation.
  const answeredByMe = new Set<string>();
  const ackedByMe = new Set<string>();
  // ADR 434 shape 4: my newest turn per thread. A steer inside a thread is answered by my next turn
  // IN that thread, `in_reply_to` or not — that is how ryder answered stanley's on 2026-09-21 and
  // was woken for it again sixteen minutes later. Keyed the way `resolve` closes a thread:
  // `m.thread ?? m.id`, so a steer that opened its own thread is answered by a turn threaded on it.
  const myLatestOnThread = new Map<string, { ts: number; id: string }>();
  for (const m of messages) {
    if (m.act === 'resolve' && m.thread) resolved.add(m.thread);
    if (m.from === me && m.thread) {
      const cur = myLatestOnThread.get(m.thread);
      if (!cur || m.ts > cur.ts || (m.ts === cur.ts && m.id > cur.id))
        myLatestOnThread.set(m.thread, { ts: m.ts, id: m.id });
    }
    const ref = (m.meta as { in_reply_to?: unknown } | null | undefined)?.['in_reply_to'];
    if (typeof ref !== 'string') continue;
    if (m.act === 'accept' || m.act === 'decline') discharged.add(ref);
    if (m.from === me) answeredByMe.add(ref);
    if (m.from === me && m.act === 'wait') ackedByMe.add(ref);
  }
  const answeredInThreadByMe = (m: Envelope): boolean => {
    const mine = myLatestOnThread.get(m.thread ?? m.id);
    return mine !== undefined && (mine.ts > m.ts || (mine.ts === m.ts && mine.id > m.id));
  };
  const isUrgent = (m: Envelope) =>
    (m.meta as { urgent?: unknown } | null | undefined)?.['urgent'] === true;
  // ADR 271 §4 (spec §3), the two incident wake edges — opt-in per team, off by default, and only on
  // the paid rail (`claimWakeLeases` passes them; the live interrupt line never does: a live seat
  // already reads the notice from its inbox). `meta.incident` is server-controlled on the same
  // grounds as `lane_review`: `routeEnvelope` strips a client-supplied copy, so a seat cannot mint
  // itself a free wake by claiming an incident was routed to it. Both notices ride `message`, which
  // nothing else here admits, so the marker is the whole test.
  const incidentOf = (m: Envelope) =>
    (m.meta as { incident?: { routed_to?: unknown; resolved_by?: unknown } } | null | undefined)
      ?.incident;
  const isIncidentRoute = (m: Envelope) =>
    opts.incidentRoutes === true && m.act === 'message' && incidentOf(m)?.routed_to === me;
  const isIncidentResolve = (m: Envelope) =>
    opts.incidentResolves === true &&
    m.act === 'message' &&
    typeof incidentOf(m)?.resolved_by === 'string';
  // ADR 225: a routed acceptance is obligation-class. Keyed on the daemon-set `lane_review` marker,
  // never on act+tier alone — a plain directed `ask` must not raise the line.
  const isObligation = (m: Envelope) =>
    opts.obligations === true &&
    m.act === 'ask' &&
    (m.meta as { lane_review?: unknown } | null | undefined)?.['lane_review'] != null;
  // ADR 378: a turn in a huddle I am IN rings the bell, so a live participant hears it at its next
  // tool boundary instead of at its next inbox check. Without this a huddle is asynchronous by
  // omission — delivery was already real-time (the ADR 061 firehose), only the bell was missing.
  //
  // Live rail only, like `obligations` and for ADR 225's reason: this predicate also picks PAID
  // wakes (`claimWakeLeases`), and raising every turn there would summon every offline participant
  // on every turn — precisely the token storm ADR 378 set out to avoid. Two flags now say
  // "live-only"; a third should collapse them into one.
  //
  // Who counts as in it: a NAMED participant (an eligible set, or a directed root) is in from the
  // root act. A `@team` huddle is an open invitation rather than a summons, so a seat joins by
  // taking a turn — otherwise one team-addressed huddle interrupts every seat on the roster, every
  // turn. Closed huddles go quiet for free: the root's id is in `resolved` once its `resolve` lands.
  // Maps each open huddle I am in to the moment I last spoke in it — `-Infinity` when I have not
  // spoken yet, so a named participant hears everything since the root. Only turns NEWER than that
  // ring: what was said before I joined is backlog I read on the way in, and the interrupt line is
  // for what needs me now, not for a transcript.
  const myOpenHuddles = new Map<string, { ts: number; id: string }>();
  if (opts.huddles === true) {
    for (const root of messages) {
      if ((root.meta as { huddle?: unknown } | null | undefined)?.['huddle'] == null) continue;
      if (resolved.has(root.id)) continue;
      const named = eligibleOf(root.meta as Record<string, unknown> | null | undefined);
      const inFromTheRoot = named
        ? named.includes(me)
        : root.to.kind === 'member' && root.to.name === me;
      // Ties on `ts` break on id, the same convention the steer scan below uses: ULIDs sort
      // deterministically, so two turns in one millisecond still have one order everybody agrees on.
      let spoke = { ts: Number.NEGATIVE_INFINITY, id: '' };
      for (const t of messages) {
        if (t.thread !== root.id || t.from !== me) continue;
        if (t.ts > spoke.ts || (t.ts === spoke.ts && t.id > spoke.id))
          spoke = { ts: t.ts, id: t.id };
      }
      const joined = spoke.ts > Number.NEGATIVE_INFINITY;
      if (inFromTheRoot || joined || root.from === me) myOpenHuddles.set(root.id, spoke);
    }
  }
  const isHuddleTurn = (m: Envelope) => {
    if (m.thread == null) return false;
    const since = myOpenHuddles.get(m.thread);
    if (since === undefined) return false;
    return m.ts > since.ts || (m.ts === since.ts && m.id > since.id);
  };
  /**
   * ADR 378 increment 4 — the OPEN act, on the wake rail: a huddle convenes the seats it names.
   *
   * The mirror image of `huddles` above, and deliberately the narrower half. That flag admits every
   * TURN and is live-rail only, because paying a wake per turn is the token storm ADR 378 exists to
   * avoid. This one admits exactly the ROOT and is what the paid rail opts into: one act, once, per
   * named seat per huddle. A turn is never a wake reason, so a busy room costs no more than a quiet
   * one — the seat woken by the open reads the whole room when it arrives.
   *
   * NAMED means named: an eligible set that includes me, or a directed root addressed to me. A
   * `@team` huddle is an open invitation and must never summon the roster — the same line the live
   * rail draws, for a much more expensive reason. My own open is not a summons to myself, and a
   * huddle whose `resolve` has landed summons nobody.
   */
  const isHuddleOpen = (m: Envelope) => {
    if (opts.huddleOpens !== true) return false;
    if ((m.meta as { huddle?: unknown } | null | undefined)?.['huddle'] == null) return false;
    if (m.from === me) return false;
    if (resolved.has(m.id)) return false;
    const named = eligibleOf(m.meta as Record<string, unknown> | null | undefined);
    return named ? named.includes(me) : m.to.kind === 'member' && m.to.name === me;
  };
  // ADR 558: discharged by an accept/decline naming it (any sender) or by my own reply — the
  // clause 7(iv) rule a steer already uses, applied to the acts the idle seam adds.
  const isDirectedIdle = (m: Envelope) =>
    opts.directed === true &&
    idleRingable(m, me) &&
    !discharged.has(m.id) &&
    !answeredByMe.has(m.id) &&
    !answeredInThreadByMe(m);
  // ADR 254: an eligible set REPLACES the default obligation rule rather than adding to it — which is
  // what narrows `request_help` from "every seat on the team" (its behaviour without a set, below) to
  // the named few. Discharge is checked here rather than at the filter so a stood-down act stops
  // being action-needed *everywhere* at once, including in the `steer` winner scan.
  const actionNeeded = (m: Envelope) => {
    if (m.act === 'resolve') return false;
    // A huddle turn is addressed to the room, not to me — the default rule below would reject it
    // before its class was ever considered. Being in the huddle IS the address (ADR 378).
    if (isHuddleTurn(m)) return true;
    // An eligible-set huddle open would otherwise fall to the `names.includes(me)` rule below and be
    // discharged by the first accept naming it — right for "any one of you answers", wrong for a
    // room: a huddle names everyone it wants IN it, and one seat turning up does not stand the rest
    // down. Answered above the discharge check for exactly that reason.
    if (isHuddleOpen(m)) return true;
    const names = eligibleOf(m.meta as Record<string, unknown> | null | undefined);
    if (names) return names.includes(me) && !discharged.has(m.id);
    return m.act === 'request_help' || (m.to.kind === 'member' && m.to.name === me);
  };
  // The single winning steer: the newest steer directed at me across the WHOLE set — resolved or not —
  // so a resolved current steer can't revive an older one it already superseded, and the bar can't
  // collapse onto a stale steer just because the newest was filtered out. (With a ts-based read cursor,
  // an older steer can't be unread while a newer one is read, so unread-only input carries the true
  // newest steer here.) Ties on `ts` (two steers in the same millisecond) break on `id` — ULIDs sort
  // deterministically — so it is always *exactly one* steer, never a contradictory pair.
  let winningSteerId: string | undefined;
  let winningTs = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    if (m.from === me || m.act !== 'steer' || !actionNeeded(m)) continue;
    if (m.ts > winningTs || (m.ts === winningTs && (winningSteerId ?? '') < m.id)) {
      winningTs = m.ts;
      winningSteerId = m.id;
    }
  }
  return messages
    .filter(
      (m) =>
        m.from !== me &&
        actionNeeded(m) &&
        (isUrgent(m) ||
          m.act === 'steer' ||
          isObligation(m) ||
          isHuddleTurn(m) ||
          isHuddleOpen(m) ||
          isIncidentRoute(m) ||
          isIncidentResolve(m) ||
          isDirectedIdle(m) ||
          (opts.answers === true && (isQuestionAnswer(m) || isPrEvent(m)))) &&
        !resolved.has(m.thread ?? m.id) &&
        // Directed obligations (no eligible set) were missing this: `discharged` only ran inside
        // the eligible-set branch of `actionNeeded`, so a self-answered `lane_review` ask kept
        // ringing. A huddle OPEN is the opposite — one named seat accepting must not stand the
        // rest down (ADR 378 inc 4). `ackedByMe` is the ADR 712 half: my own `wait` stops the
        // bell for me and leaves every other named seat still owing a verdict.
        !(isObligation(m) && (discharged.has(m.id) || ackedByMe.has(m.id))) &&
        // Newest steer wins: any steer that isn't the single winner is superseded — it neither
        // interrupts nor counts (a ts tie is broken by id, so no two steers survive together).
        // A winner this seat already replied to is discharged (clause 7(iv)) — and because the
        // winner is chosen over the whole set first, the superseded steers under it do not rise.
        (m.act !== 'steer' ||
          (m.id === winningSteerId && !answeredByMe.has(m.id) && !answeredInThreadByMe(m))),
    )
    .sort((a, b) => b.ts - a.ts);
}

/** One act `me` has postponed, and what will bring it back (ADR 211 §1). */
export interface Deferral {
  /** the directed act being postponed */
  target: string;
  /** the deferring `wait`'s id */
  by: string;
  /** the deferring `wait`'s ts — the bar every condition is measured against */
  ts: number;
  until: DeferUntil;
}

/**
 * The deferrals `me` currently holds, latest-wins per target (ADR 211 §3).
 *
 * A deferring `wait` (`meta.defer_ref` + `meta.until`) postpones one directed act. Re-deferring is
 * appending another `wait`, so this is a pure read-side collapse — no supersede column, no
 * write-path side-effect — the same shape as the steer supersession above. A ts tie breaks on id,
 * as ULIDs sort deterministically, so the fold never depends on input order.
 *
 * Only waits authored by `me` count: deferring someone else's inbox item is not expressible here,
 * and the transport rejects it besides.
 */
export function deferrals(messages: Envelope[], me: string): Map<string, Deferral> {
  const out = new Map<string, Deferral>();
  for (const m of messages) {
    if (m.act !== 'wait' || m.from !== me) continue;
    const meta = (m.meta ?? {}) as { defer_ref?: unknown; until?: unknown };
    if (typeof meta.defer_ref !== 'string' || meta.defer_ref.trim().length === 0) continue;
    const until = DeferUntilSchema.safeParse(meta.until);
    if (!until.success) continue;
    const prev = out.get(meta.defer_ref);
    if (prev && (prev.ts > m.ts || (prev.ts === m.ts && prev.by >= m.id))) continue;
    out.set(meta.defer_ref, { target: meta.defer_ref, by: m.id, ts: m.ts, until: until.data });
  }
  return out;
}

/**
 * The deferred targets whose condition has since fired (ADR 211 §2).
 *
 * Both conditions reduce to one question — does an act exist on this subject with a ts later than
 * the deferral's? — so there is one predicate over two subjects, and no clock anywhere (ADR 179).
 *
 * `{ lane }` is deliberately LOOSE: it fires on the first lane-state act for that lane after the
 * wait, which may not be the state the deferrer wanted. Naming a target state would be more precise
 * and more to get wrong; evidence can argue for the precise form later.
 *
 * The bar is the NEWEST wait per target (whatever `deferrals` folded), so re-deferring genuinely
 * re-postpones rather than leaving a raise latched from a superseded wait. A target whose thread is
 * closed (ADR 025 `resolve`) never raises — the work it postponed is over.
 */
export function raisedDeferrals(messages: Envelope[], me: string): Set<string> {
  const held = deferrals(messages, me);
  const out = new Set<string>();
  if (held.size === 0) return out;

  const threadOf = new Map<string, string>();
  for (const m of messages) threadOf.set(m.id, m.thread ?? m.id);
  const resolved = new Set<string>();
  for (const m of messages) if (m.act === 'resolve' && m.thread) resolved.add(m.thread);

  for (const [target, d] of held) {
    const thread = threadOf.get(target) ?? target;
    if (resolved.has(thread)) continue;
    const fired = messages.some((m) => {
      if (m.ts <= d.ts) return false;
      if ('reply' in d.until) return m.from !== me && (m.thread ?? m.id) === thread;
      const laneState = (m.meta ?? {}) as { lane_state?: { lane?: unknown } };
      return laneState.lane_state?.lane === d.until.lane;
    });
    if (fired) out.add(target);
  }
  return out;
}

/** A deferral this old that has not raised is the ADR 211 loss mode — surfaced, never actuated. */
export const LONG_DEFERRED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The deferrals that have gone quiet (ADR 211 Failure mode): older than the threshold and still not
 * raised. An act deferred until a lane that never moves again is never raised, so postponement
 * becomes a tidy way to drop work — this is the exception that makes that visible.
 *
 * Warn, never block, never auto-un-defer. The system does not get to decide on a Member's behalf
 * that their deferral has expired; it only says the condition has not fired in a long time.
 */
export function longDeferred(
  messages: Envelope[],
  me: string,
  now: number,
  thresholdMs: number = LONG_DEFERRED_MS,
): { target: string; until: 'lane' | 'reply'; deferred_ts: number; age_days: number }[] {
  const raised = raisedDeferrals(messages, me);
  const out: { target: string; until: 'lane' | 'reply'; deferred_ts: number; age_days: number }[] =
    [];
  for (const d of deferrals(messages, me).values()) {
    if (raised.has(d.target)) continue;
    const age = now - d.ts;
    if (age < thresholdMs) continue;
    out.push({
      target: d.target,
      until: 'reply' in d.until ? 'reply' : 'lane',
      deferred_ts: d.ts,
      age_days: Math.floor(age / (24 * 60 * 60 * 1000)),
    });
  }
  return out.sort((a, b) => a.deferred_ts - b.deferred_ts);
}

/**
 * The member's most recent `status_update` reduced to a roster label + when it was set.
 * The label is `meta.state` (the SPEC field) or, if absent, the message body. Returns null
 * if the member has never posted a status_update with any label text.
 */
export async function latestStatusUpdate(
  db: Driver,
  memberId: string,
): Promise<{ state: string; ts: number } | null> {
  const row = await db.get<{ body: string; meta: string | null; ts: number }>(
    "SELECT body, meta, ts FROM messages WHERE from_member = ? AND act = 'status_update' ORDER BY ts DESC, id DESC LIMIT 1",
    [memberId],
  );
  return row ? statusState(row) : null;
}

/** The working label a status_update row carries: `meta.state` when set, else the body. */
function statusState(row: {
  body: string;
  meta: string | null;
  ts: number;
}): { state: string; ts: number } | null {
  const metaState = row.meta
    ? (JSON.parse(row.meta) as Record<string, unknown>)['state']
    : undefined;
  const state = (typeof metaState === 'string' && metaState.trim() ? metaState : row.body).trim();
  return state ? { state, ts: row.ts } : null;
}

/**
 * {@link latestStatusUpdate} for every current member of a team, in ONE statement (lane
 * 01M3ZCTQK9): the roster asked once per member, and on Postgres each ask is its own five-round-trip
 * transaction. The correlated pick is the same `ORDER BY ts DESC, id DESC LIMIT 1` per member, so it
 * rides a per-member index exactly as the single lookup does — on Postgres only while `messages`
 * statistics know the team (schema v89 keeps them fresh; stale, the tenant policy's `team_id` qual
 * plans a per-team scan, 32 ms vs 3.8 ms in Cloud run 14). Keyed by member id; a member with no
 * status_update is absent.
 */
export async function latestStatusUpdates(
  db: Driver,
  teamId: string,
): Promise<Map<string, RosterStatus>> {
  // Two latest-per-member picks in one statement: the newest status_update of any address, and the
  // newest that is not a human-to-human DM (ADR 601 decision 5). A `broadcast` or `public` reader is
  // shown the second; everyone else the first. Found while designing ADR 601: a human's DM to
  // another human, sent as a `status_update`, was that human's roster line on the public stream.
  const rows = await db.all<{
    from_member: string;
    body: string;
    meta: string | null;
    ts: number;
    open: number;
  }>(
    `SELECT msg.from_member AS from_member, msg.body AS body, msg.meta AS meta, msg.ts AS ts, 0 AS open
       FROM messages msg
      WHERE msg.id IN (
        SELECT (SELECT x.id FROM messages x
                 WHERE x.from_member = m.id AND x.act = 'status_update'
                 ORDER BY x.ts DESC, x.id DESC LIMIT 1)
          FROM members m
         WHERE m.team_id = ? AND m.left_at IS NULL)
     UNION ALL
     SELECT msg.from_member AS from_member, msg.body AS body, msg.meta AS meta, msg.ts AS ts, 1 AS open
       FROM messages msg
      WHERE msg.id IN (
        SELECT (SELECT x.id FROM messages x
                 WHERE x.from_member = m.id AND x.act = 'status_update'
                   AND NOT ${humanPairSql('x')}
                 ORDER BY x.ts DESC, x.id DESC LIMIT 1)
          FROM members m
         WHERE m.team_id = ? AND m.left_at IS NULL)`,
    [teamId, teamId],
  );
  const out = new Map<string, RosterStatus>();
  for (const row of rows.filter((r) => Number(r.open) === 0)) {
    const status = statusState(row);
    if (status) out.set(row.from_member, { ...status, open: null });
  }
  for (const row of rows.filter((r) => Number(r.open) === 1)) {
    const status = statusState(row);
    const cur = out.get(row.from_member);
    if (status && cur) cur.open = status;
  }
  return out;
}

/**
 * A member's roster line: the latest `status_update` whatever it was addressed to, and `open`, the
 * latest that was not a human-to-human DM — what a `broadcast` or `public` reader is shown (ADR 601).
 * `open` is null when every status_update the member ever sent was a human-pair DM.
 */
export interface RosterStatus {
  state: string;
  ts: number;
  open: { state: string; ts: number } | null;
}

/**
 * The SQL of ADR 601's one exclusion: a member-addressed act whose sender and recipient are both
 * human, non-observer members. Service seats are agents; an observer is never a human end. Named
 * once so the history read and the roster line cannot drift; the live fan-out computes the same
 * pair from the two member rows it already holds (`route.ts`, `humanPair`).
 */
export function humanPairSql(alias: string): string {
  return `(${alias}.to_kind = 'member'
    AND EXISTS (SELECT 1 FROM members hs WHERE hs.id = ${alias}.from_member
                  AND hs.kind = 'human' AND hs.observer = 0)
    AND EXISTS (SELECT 1 FROM members hr WHERE hr.id = ${alias}.to_member
                  AND hr.kind = 'human' AND hr.observer = 0))`;
}

/**
 * What a READER may see of the timeline (ADR 407): the reader's grade from `messageVisibilityOf`,
 * plus its id so the confidential clause can exempt the reader's own acts. Distinct from
 * {@link TeamMessagesOpts.forMemberId}, which is a PARTY scope — "what is this member in" — and is
 * what the deferral fold and the residency poll ask; those are delivery-side questions and ADR 407
 * §2 leaves them exactly where they were.
 */
export interface ReadScope {
  grade: MessageVisibility;
  readerId: string;
}

export interface TeamMessagesOpts {
  since?: number;
  limit?: number;
  /**
   * Party-scoping: when set, restrict the timeline to envelopes this member is a party to — sender,
   * recipient, or a team/broadcast act. From ADR 128 to ADR 407 this was ALSO the visibility rule
   * for a regular member's `GET /messages`; it no longer is (see {@link ReadScope}). It remains the
   * right question for the two delivery-side callers that ask "what am I in": `deferralFold` and
   * the residency poll.
   */
  forMemberId?: string;
  /** Visibility scoping for a timeline READ (ADR 407). Wins over `forMemberId` when both are set. */
  scope?: ReadScope;
}

/**
 * The SQL half of ADR 407's visibility grades. Mirrors `confidentialAskSubject` in the protocol —
 * an `ask` whose `meta.about` is a non-empty string — and MUST stay in step with it: the firehose
 * asks the function, this read asks the column, and a divergence is a message visible on one
 * surface and hidden on the other.
 */
function readScopeSql(scope: ReadScope): { sql: string; params: unknown[] } {
  switch (scope.grade) {
    case 'full':
      return { sql: '', params: [] };
    case 'team':
      // Everything but a confidential ask the reader is not party to. `IS NOT` rather than `!=` so
      // a NULL `to_member` (impossible for a valid `about`, but a row is not a validator) excludes
      // rather than yielding NULL and vanishing from the NOT.
      return {
        sql:
          " AND NOT (act = 'ask' AND json_extract(meta, '$.about') IS NOT NULL" +
          " AND json_extract(meta, '$.about') != ''" +
          ' AND from_member IS NOT ? AND to_member IS NOT ?)',
        params: [scope.readerId, scope.readerId],
      };
    case 'broadcast':
      // ADR 601: everything, minus the human-to-human DM. The stream's own mail is never a human
      // pair (an observer is not a human end). A talk-only guest IS a human end (ADR 621 §7, ADR 616
      // §5): its own conversation with another human stays visible to it, so the reader is exempt.
      return {
        sql: ` AND (NOT ${humanPairSql('messages')} OR from_member = ? OR to_member = ?)`,
        params: [scope.readerId, scope.readerId],
      };
    case 'public':
      // The ADR 128 party predicate, which for an observer — never a sender, never a directed
      // recipient except of its own mail — collapses to exactly the public timeline (ADR 136).
      return {
        sql: " AND (from_member = ? OR to_member = ? OR to_kind IN ('team','broadcast'))",
        params: [scope.readerId, scope.readerId],
      };
  }
}

/**
 * The whole team timeline — every persisted envelope, regardless of recipient — for the firehose's
 * history backfill (`GET /teams/:slug/messages`, ADR 061). Always returned in ascending (`ts, id`)
 * display order; `limit` caps the page (default 200). The two modes differ only in *which* window the
 * cap keeps:
 *
 * - **No `since` (initial backfill):** the most RECENT `limit` messages. This is what every live view
 *   wants — you open `/live` (or `musterd inbox`) to see what just happened, not the team's first 200
 *   messages ever. (The prior `ORDER BY ts ASC LIMIT` kept the OLDEST `limit` and silently dropped the
 *   newest on any over-cap history, so a busy team's backfill missed exactly the acts it came for —
 *   they only trickled in over the live socket. ADR 107 verification surfaced this.)
 * - **`since` (forward catch-up):** the oldest `limit` messages strictly after `since` (by ts), so a
 *   caller holding a cursor can page forward without skipping the gap. `since` is exclusive.
 */
export async function listTeamMessages(
  db: Driver,
  teamId: string,
  opts: TeamMessagesOpts = {},
): Promise<MessageRow[]> {
  const limit = opts.limit ?? 200;
  // A READ scope (ADR 407 grade) or a PARTY scope (what this member is in) — see the opts.
  const scoped = opts.scope
    ? readScopeSql(opts.scope)
    : opts.forMemberId
      ? {
          sql: " AND (from_member = ? OR to_member = ? OR to_kind IN ('team','broadcast'))",
          params: [opts.forMemberId, opts.forMemberId],
        }
      : { sql: '', params: [] };
  const scopeSql = scoped.sql;
  const scopeParams = scoped.params;
  if (typeof opts.since === 'number') {
    // Forward catch-up: walk forward from the cursor, oldest-first, so no message in the gap is skipped.
    return await db.all<MessageRow>(
      `SELECT * FROM messages WHERE team_id = ? AND ts > ?${scopeSql} ORDER BY ts ASC, id ASC LIMIT ?`,
      [teamId, opts.since, ...scopeParams, limit],
    );
  }
  // Initial backfill: take the newest `limit` (DESC + LIMIT), then re-sort ascending for display.
  return await db.all<MessageRow>(
    `SELECT * FROM (SELECT * FROM messages WHERE team_id = ?${scopeSql} ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC`,
    [teamId, ...scopeParams, limit],
  );
}

/** Convert a stored row back to a protocol Envelope (for delivery/inbox responses). */
export function rowToEnvelope(
  row: MessageRow,
  teamSlug: string,
  fromName: string,
  toName: string | null,
): Envelope {
  const to =
    row.to_kind === 'member'
      ? { kind: 'member' as const, name: toName ?? '' }
      : row.to_kind === 'team'
        ? { kind: 'team' as const }
        : { kind: 'broadcast' as const };
  return {
    id: row.id,
    v: PROTOCOL_VERSION,
    team: teamSlug,
    from: fromName,
    to,
    act: row.act as Envelope['act'],
    body: row.body,
    thread: row.thread_id,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
    ts: row.ts,
    received_at: row.created_at,
  };
}
