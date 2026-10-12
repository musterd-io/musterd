import {
  eligibleOf,
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  normalizeSeatName,
  type ActDelivery,
  type DeliveryRecipient,
  type LaneState,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { getCursor } from './cursors.js';
import { repliedByRecipientWhere, undischargedSql } from './discharge.js';
import type { MessageRow } from './rows.js';

/**
 * The per-recipient delivery ledger (ADR 090) — `logged → seen → answered`, **derived** from the
 * message log + inbox cursors + the interrupt audit, never stored. `logged` is implicit (the row
 * exists; durability IS delivery, so there is no local `failed`); `seen` is the recipient's cursor
 * watermark crossing the act (exact as a boolean, watermark-precise as a timestamp); `answered` is
 * the same predicate `countOpenLoops`/`recordLoopClosure` use (an accept/decline naming the act via
 * `meta.in_reply_to`, or a resolve on its thread). Pure reads, the `countOpenLoops` pattern.
 */

interface RecipientRow {
  id: string;
  name: string;
}

/** Whom a persisted act addresses. For team/broadcast this is the *current* non-observer roster
 * minus the sender — membership that changed since the send is approximated by the roster of now
 * (the log stores no fan-out list; ADR 090 accepts and labels this). */
async function recipientsOf(db: Driver, msg: MessageRow): Promise<RecipientRow[]> {
  if (msg.to_kind === 'member') {
    if (!msg.to_member) return [];
    const row = await db.get<RecipientRow>('SELECT id, name FROM members WHERE id = ?', [
      msg.to_member,
    ]);
    return row ? [row] : [];
  }
  // ADR 254: an eligible set narrows OBLIGATION, not visibility. The act is team-addressed and every
  // seat can read it — but only the named seats owe an answer, and this ledger tracks what is owed.
  //
  // Note this branch is strictly MORE precise than the roster query below: the names are pinned in
  // the envelope, so a seat that has since left is still visibly the one who was asked. There is
  // deliberately no `left_at IS NULL` filter here — dropping a departed seat would rewrite history
  // into "we never asked them", which is the approximation the team branch is stuck with, not one to
  // reproduce where the log actually knows better.
  const eligible = eligibleOf(metaOf(msg));
  if (eligible) {
    const out: RecipientRow[] = [];
    for (const name of eligible) {
      const row = await db.get<RecipientRow>(
        'SELECT id, name FROM members WHERE team_id = ? AND name = ?',
        [msg.team_id, name],
      );
      if (row) out.push(row);
    }
    return out;
  }
  return await db.all<RecipientRow>(
    'SELECT id, name FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND id != ?',
    [msg.team_id, msg.from_member],
  );
}

/** An act's decoded `meta`, or null when absent/corrupt. */
function metaOf(msg: MessageRow): Record<string, unknown> | null {
  if (!msg.meta) return null;
  try {
    return JSON.parse(msg.meta) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isUrgent(msg: MessageRow): boolean {
  return metaOf(msg)?.['urgent'] === true;
}

/** The resolve that closed this act's thread (thread_key = thread_id ?? id), if any. */
async function threadResolve(
  db: Driver,
  msg: MessageRow,
): Promise<{ act: string; id: string; ts: number } | null> {
  const threadKey = msg.thread_id ?? msg.id;
  const row = await db.get<{ id: string; ts: number }>(
    `SELECT id, ts FROM messages WHERE team_id = ? AND act = 'resolve' AND thread_id = ? ORDER BY ts ASC LIMIT 1`,
    [msg.team_id, threadKey],
  );
  return row ? { act: 'resolve', id: row.id, ts: row.ts } : null;
}

/**
 * ADR 254: ANY seat's accept/decline naming the act — the any-of discharge an eligible set promises.
 *
 * This clause has to exist, and the reason is worth recording because the design assumed it away:
 * `answerBy` below is scoped to a single recipient (`from_member = recipientId`), which is exactly
 * right for a directed act and exactly wrong for "either of you". Without this, bob answering would
 * leave Ada owing the act forever, and the ledger — the instrument that decides what is still open —
 * would contradict the primitive's whole promise.
 *
 * Applied ONLY when the act carries an eligible set. A plain team act keeps per-recipient answering,
 * because there "someone replied" genuinely does not mean everyone else is off the hook.
 */
async function anyAnswer(
  db: Driver,
  msg: MessageRow,
): Promise<{ act: string; id: string; ts: number } | null> {
  const row = await db.get<{ act: string; id: string; ts: number }>(
    `SELECT act, id, ts FROM messages
        WHERE team_id = ? AND act IN ('accept','decline')
          AND in_reply_to = ?
        ORDER BY ts ASC LIMIT 1`,
    [msg.team_id, msg.id],
  );
  return row ?? null;
}

/**
 * This recipient's own reply that discharges the act, if any — ADR 434's shapes 3 and 4, read off
 * the one predicate in `discharge.ts`: any act of theirs naming it by `meta.in_reply_to`, or any
 * act of theirs in its thread and newer than it. It used to admit only an `accept`/`decline`, so
 * gptbot's "standing down" `message` (in_reply_to set, 13:19 and 13:43 on 2026-09-21) left the
 * ledger's `answered` null and the batched lane leased the act three times.
 */
async function answerBy(
  db: Driver,
  msg: MessageRow,
  recipientId: string,
): Promise<{ act: string; id: string; ts: number } | null> {
  const row = await db.get<{ act: string; id: string; ts: number }>(
    `SELECT dy.act, dy.id, dy.ts FROM messages dy
         JOIN messages m ON m.id = ?
        WHERE ${repliedByRecipientWhere('m', '?')}
        ORDER BY dy.created_at ASC, dy.id ASC LIMIT 1`,
    [msg.id, recipientId],
  );
  return row ?? null;
}

/**
 * A handoff is discharged by DOING THE WORK, and that is invisible to the two reply-shaped clauses
 * above. This is the third clause: the lane a `lane_handoff` names has left the recipient's plate.
 *
 * WHY IT HAD TO EXIST, measured on the live ledger 2026-08-06. miley handed ryder lane
 * `01KZ9W0R29`; he diagnosed it, shipped ADR 246 (#716/#722) and submitted at 18:19:57. No `accept`
 * ever named the handoff and no `resolve` ever landed on its thread — because that is not how anyone
 * discharges a handoff. So the wake-candidate query never learned the work was done and kept
 * spawning sessions three hours later. Her ONE handoff was TWO envelopes and the attempt cap keys
 * per act, so it bought six wakes for already-merged work, entirely within policy.
 *
 * DERIVED, NEVER STORED — the same posture as the rest of this file, and here it buys a property a
 * stored flag could not: if acceptance REJECTS the lane it returns to an active state and the
 * handoff becomes owed again on the next read, with nothing to un-set.
 *
 * Deliberately narrow. Only a handoff that NAMES a lane, and only when that lane currently exists
 * and is out of play: submitted for acceptance (either ADR 169/192 spelling) or terminal. A bare
 * handoff, or one naming a lane that no longer exists, keeps its old behaviour rather than silently
 * going quiet — a wake that should not have fired is expensive, but a handoff that stops asking is
 * work dropped on the floor, and only one of those is recoverable.
 *
 * Exported so every reader of a handoff-as-live-instruction (wake candidacy, orientation `why`)
 * uses the same out-of-play test. A second copy in `orientation.ts` is how the `why` kept serving
 * discharged work after this clause landed for wakes (#745).
 */
export async function handoffNamedLaneOutOfPlay(
  db: Driver,
  teamId: string,
  meta: string | null,
  body?: string | null,
): Promise<boolean> {
  const lane = await namedHandoffLane(db, teamId, meta);
  if (lane) return laneOutOfPlay(lane.state);
  // No structured lane. ADR 231 (#662) made every handoff carry one, but the 24 that predate it
  // never will, and a bare handoff is always "in play" — so the newest one wins the `why` slot
  // PERMANENTLY, outranking every structured handoff older than it, with no event able to retire
  // it. Measured 2026-08-12: 34 handoffs, 24 bare, 7 naming their lane in the body, the oldest
  // still served as a live instruction 16 days after its lane shipped.
  //
  // A lane id in prose is not prose: it resolves to a lane row or it does not. What keeps this on
  // the right side of "only a recorded fact earns a label" is that nothing here reads MEANING —
  // an identifier is matched, and an ambiguous or unresolvable one abstains.
  return await bodyNamedLanesAllOutOfPlay(db, teamId, body);
}

function laneOutOfPlay(state: string): boolean {
  return isAwaitingAcceptance(state) || LANE_TERMINAL_STATES.has(state as LaneState);
}

/**
 * Lane ids as they appear in prose: rendered TRUNCATED (`01KYJ8B5AB` for the full 26-char ULID), so
 * this matches a Crockford-base32 ULID prefix of at least 10 characters. Below that a prefix stops
 * being distinguishing; `I`, `L`, `O` and `U` are outside the alphabet.
 */
const LANE_ID_IN_PROSE = /\b01[0-9A-HJKMNP-TV-Z]{8,24}\b/g;

/**
 * True only when the body names at least one lane and EVERY lane it names has left play.
 *
 * All-or-nothing on purpose. Real handoffs name more than one lane — the one being handed off and a
 * lane it overlaps or supersedes (the measured example named both its subject and a surface-overlap
 * neighbour). Discharging on "some named lane is done" would silence a live handoff because it
 * mentioned a finished one in passing, and this file's own rule is that a wake which should not have
 * fired is expensive while a handoff that stops asking is work dropped on the floor — only one of
 * those is recoverable. So any still-live mention keeps the whole handoff showing.
 */
async function bodyNamedLanesAllOutOfPlay(
  db: Driver,
  teamId: string,
  body?: string | null,
): Promise<boolean> {
  const states = await bodyNamedLaneStates(db, teamId, body);
  return states.length > 0 && states.every(laneOutOfPlay);
}

/**
 * The states of every lane this body names and resolves to exactly one row. An ambiguous prefix
 * picked out no single lane, so it is not evidence about any of them and is dropped.
 */
async function bodyNamedLaneStates(
  db: Driver,
  teamId: string,
  body?: string | null,
): Promise<string[]> {
  return (await bodyNamedLanes(db, teamId, body)).map((l) => l.state);
}

async function bodyNamedLanes(
  db: Driver,
  teamId: string,
  body?: string | null,
): Promise<{ id: string; state: string }[]> {
  if (!body) return [];
  const prefixes = [...new Set(body.match(LANE_ID_IN_PROSE) ?? [])];
  const lanes: { id: string; state: string }[] = [];
  for (const prefix of prefixes) {
    // LIMIT 2 is enough to tell "exactly one" from "more than one" without scanning the rest.
    const matches = await db.all<{ id: string; state: string }>(
      "SELECT id, state FROM lanes WHERE team_id = ? AND id LIKE ? || '%' LIMIT 2",
      [teamId, prefix],
    );
    if (matches.length !== 1) continue;
    lanes.push(matches[0]!);
  }
  return lanes;
}

/**
 * Every lane a handoff names and this team resolves — the structured `meta.lane_handoff.lane` and
 * each prose id that picks out exactly one row — deduplicated, in no particular order.
 *
 * ADR 536 tier 1: the orientation brief's `up_next` ranks these (and the lanes under the handoff's
 * `meta.goal_id`) above every derived signal, because the handoff is the human-authored why
 * (ADR 049). Same resolution rules as the out-of-play test above, so the lane the brief ranks first
 * is the lane the `why` slot is talking about — an ambiguous prefix names nothing here either.
 */
export async function handoffNamedLaneIds(
  db: Driver,
  teamId: string,
  meta: string | null,
  body?: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  const structured = await namedHandoffLane(db, teamId, meta);
  if (structured) ids.add(structured.id);
  for (const l of await bodyNamedLanes(db, teamId, body)) ids.add(l.id);
  return [...ids];
}

/**
 * True when a handoff names NO lane this team can resolve — not in `meta`, not in prose. Such a
 * handoff carries no recorded fact any event can act on: `handoffNamedLaneOutOfPlay` is false for
 * it forever, so nothing can ever retire it. Callers that serve a handoff as a live instruction use
 * this to decide whether they hold a checkable claim or only an uncheckable one; what they do about
 * it is theirs (the orientation `why` bounds it by age — ADR 264 — while wake candidacy does not).
 */
export async function handoffNamesNoLane(
  db: Driver,
  teamId: string,
  meta: string | null,
  body?: string | null,
): Promise<boolean> {
  if (await namedHandoffLane(db, teamId, meta)) return false;
  return (await bodyNamedLaneStates(db, teamId, body)).length === 0;
}

async function namedHandoffLane(
  db: Driver,
  teamId: string,
  meta: string | null,
): Promise<{ id: string; state: string; updated_at: number } | null> {
  if (!meta) return null;
  let laneId: unknown;
  try {
    const parsed = JSON.parse(meta) as { lane_handoff?: { lane?: unknown } };
    laneId = parsed.lane_handoff?.lane;
  } catch {
    return null; // unparseable meta is not evidence of discharge
  }
  if (typeof laneId !== 'string' || laneId === '') return null;
  const lane = await db.get<{ id: string; state: string; updated_at: number }>(
    'SELECT id, state, updated_at FROM lanes WHERE team_id = ? AND id = ?',
    [teamId, laneId],
  );
  return lane ?? null;
}

async function laneHandoffDischarged(
  db: Driver,
  msg: MessageRow,
): Promise<{ act: string; id: string; ts: number } | null> {
  if (msg.act !== 'handoff') return null;
  const lane = await namedHandoffLane(db, msg.team_id, msg.meta);
  if (!lane) return null;
  if (!isAwaitingAcceptance(lane.state) && !LANE_TERMINAL_STATES.has(lane.state as LaneState)) {
    return null;
  }
  // `id` names the LANE, not a message: this closure has no envelope of its own, and pointing at a
  // real lane is more useful to a reader of the ledger than a synthetic message id would be.
  return { act: `lane:${lane.state}`, id: lane.id, ts: lane.updated_at };
}

/**
 * Has this recipient ANSWERED the act, by the ledger's own definition — an accept/decline naming
 * it via `meta.in_reply_to`, or a `resolve` closing its thread? Exported for the wake metrics
 * (ADR 131 O&E: "woken acts that reach `answered` in the ADR 090 ledger"), so the report reads
 * the LIVE ledger state rather than the host's report-time snapshot.
 */
export async function actAnswered(
  db: Driver,
  msg: MessageRow,
  recipientId: string,
): Promise<{ act: string; id: string; ts: number } | null> {
  return (
    (await answerBy(db, msg, recipientId)) ??
    (await threadResolve(db, msg)) ??
    (await laneHandoffDischarged(db, msg))
  );
}

/** ADR 088 interrupt raises recorded for this (act, recipient) — the attempt history. */
async function interruptRaises(
  db: Driver,
  msg: MessageRow,
  recipientName: string,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'interrupt.raised' AND target = ?
          AND json_extract(detail, '$.act') = ?`,
    [msg.team_id, recipientName, msg.id],
  );
  return row?.n ?? 0;
}

/** ADR 167 delivery-rail relays confirmed for this act — the exact `interruptRaises` pattern: an
 *  attempt is an audit row (`actor.session_message` whose `nudge_ref` names the act), the ledger
 *  projects it. The nudge row carries no recipient of its own (only the sender is authenticated),
 *  but a `nudge_ref` resolves through the act, whose recipient is fixed — so the count is per-act,
 *  landing on its one directed recipient. `verbatim` counts the fingerprint-matched subset. */
async function ccdNudges(
  db: Driver,
  msg: MessageRow,
): Promise<{ total: number; verbatim: number }> {
  const row = await db.get<{ total: number; verbatim: number }>(
    `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN json_extract(detail, '$.verbatim') = 1 THEN 1 ELSE 0 END), 0) AS verbatim
         FROM audit
        WHERE team_id = ? AND action = 'actor.session_message'
          AND json_extract(detail, '$.nudge_ref') = ?`,
    [msg.team_id, msg.id],
  );
  return { total: row?.total ?? 0, verbatim: row?.verbatim ?? 0 };
}

/**
 * The two audit counts `recipientLedger` reads, tallied once for a whole ledger instead of once per
 * (act, recipient). Each per-call read scans every `interrupt.raised` / `actor.session_message` row
 * for the team through `json_extract` — 189 such calls were ~1s of the hub's 2s
 * `openDirectedLedger`, which every wake-lease poll runs (2026-10-12). Same rows, same predicates,
 * grouped instead of probed.
 */
interface AuditTallies {
  raises: Map<string, number>;
  nudges: Map<string, { total: number; verbatim: number }>;
}

const raiseKey = (recipientName: string, actId: string): string => `${recipientName}\0${actId}`;

async function auditTallies(db: Driver, teamId: string): Promise<AuditTallies> {
  const raises = new Map<string, number>();
  for (const r of await db.all<{ target: string; act: string | null; n: number }>(
    `SELECT target, json_extract(detail, '$.act') AS act, COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'interrupt.raised'
        GROUP BY target, json_extract(detail, '$.act')`,
    [teamId],
  )) {
    if (r.act !== null) raises.set(raiseKey(r.target, String(r.act)), Number(r.n));
  }
  const nudges = new Map<string, { total: number; verbatim: number }>();
  for (const r of await db.all<{ ref: string | null; total: number; verbatim: number }>(
    `SELECT json_extract(detail, '$.nudge_ref') AS ref, COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN json_extract(detail, '$.verbatim') = 1 THEN 1 ELSE 0 END), 0) AS verbatim
         FROM audit
        WHERE team_id = ? AND action = 'actor.session_message'
        GROUP BY json_extract(detail, '$.nudge_ref')`,
    [teamId],
  )) {
    if (r.ref !== null) {
      nudges.set(String(r.ref), { total: Number(r.total), verbatim: Number(r.verbatim) });
    }
  }
  return { raises, nudges };
}

async function recipientLedger(
  db: Driver,
  msg: MessageRow,
  recipient: RecipientRow,
  resolve: { act: string; id: string; ts: number } | null,
  tallies?: AuditTallies,
): Promise<DeliveryRecipient> {
  // ADR 254: on an eligible-set act the FIRST answer from anyone discharges it for every named seat
  // (`anyAnswer`); everywhere else the per-recipient clause stands unchanged.
  const ownAnswer = eligibleOf(metaOf(msg))
    ? await anyAnswer(db, msg)
    : await answerBy(db, msg, recipient.id);
  const answered = ownAnswer ?? resolve ?? (await laneHandoffDischarged(db, msg));
  const cursor = await getCursor(db, recipient.id);
  // The cursor is a `(created_at, id)` point, not a ts (ADR 290, amended 2026-08-20; re-keyed from
  // `ts` to receipt by the ts-cursor fix, see `cursors.ts`). Comparing on ts alone called an act
  // tied with the cursor row SEEN although the reader was never handed it — while `listInbox`
  // called that same act unread, so one message was both at once. `>=` on the id is deliberate:
  // the cursor row itself IS seen, everything tied after it is not.
  const seen =
    cursor.last_read_ts > msg.created_at ||
    (cursor.last_read_ts === msg.created_at &&
      cursor.last_read_message_id !== null &&
      cursor.last_read_message_id >= msg.id);
  const nudges = tallies
    ? (tallies.nudges.get(msg.id) ?? { total: 0, verbatim: 0 })
    : await ccdNudges(db, msg);
  return {
    seat: recipient.name,
    seat_id: normalizeSeatName(recipient.name),
    state: answered ? 'answered' : seen ? 'seen' : 'logged',
    seen_by: seen ? cursor.updated_at : null,
    answered,
    interrupt_raises: tallies
      ? (tallies.raises.get(raiseKey(recipient.name, msg.id)) ?? 0)
      : await interruptRaises(db, msg, recipient.name),
    ccd_nudges: nudges.total,
    ccd_nudges_verbatim: nudges.verbatim,
  };
}

async function actDeliveryOf(
  db: Driver,
  msg: MessageRow,
  now: number,
  tallies?: AuditTallies,
): Promise<ActDelivery> {
  const resolve = await threadResolve(db, msg);
  const from = await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [
    msg.from_member,
  ]);
  return {
    id: msg.id,
    act: msg.act,
    from: from?.name ?? '?',
    to_kind: msg.to_kind as ActDelivery['to_kind'],
    thread: msg.thread_id,
    ts: msg.ts,
    age_ms: Math.max(0, now - msg.ts),
    urgent: isUrgent(msg),
    recipients: await Promise.all(
      (await recipientsOf(db, msg)).map((r) => recipientLedger(db, msg, r, resolve, tallies)),
    ),
  };
}

/**
 * The acts a cursor advance from `fromTs` (exclusive) to `toTs` (inclusive) newly marks seen, for
 * the `musterd.coordination.seen_latency` emission (ADR 090). Both bounds are cursor positions —
 * `created_at`, receipt order — while the returned `ts` stays the envelope's own, because the
 * latency measured from it is send→seen. Scope matches the ledger, not the
 * whole team firehose: acts directed at me, plus team/broadcast **loop-opening** acts
 * (request_help/handoff — their `to_member` is NULL, so a `to_member = me` filter alone silently
 * skips them; bugbot on #114). Never my own sends.
 */
export async function crossedBySeen(
  db: Driver,
  teamId: string,
  memberId: string,
  fromTs: number,
  toTs: number,
): Promise<{ act: string; urgent: boolean; ts: number }[]> {
  const rows = await db.all<MessageRow>(
    `SELECT * FROM messages
        WHERE team_id = ? AND created_at > ? AND created_at <= ?
          AND (to_member = ?
               OR (to_kind IN ('team','broadcast') AND act IN ('request_help','handoff')))
          AND from_member != ?`,
    [teamId, fromTs, toTs, memberId, memberId],
  );
  return rows.map((m) => ({ act: m.act, urgent: isUrgent(m), ts: m.ts }));
}

/** The per-act ledger: one act's journey across every recipient. Null for an unknown id. */
export async function actDelivery(
  db: Driver,
  teamId: string,
  messageId: string,
  now: number = Date.now(),
): Promise<ActDelivery | null> {
  const msg = await db.get<MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?', [
    teamId,
    messageId,
  ]);
  return msg ? await actDeliveryOf(db, msg, now) : null;
}

/**
 * The open directed ledger (ADR 090 §2): every loop-opening act — `request_help`/`handoff`, plus
 * urgent-flagged directed acts — not yet answered by an accept/decline naming it or a resolve on
 * its thread. This is the `open_loops` gauge made answerable (which act, whose inbox, seen or
 * ignored), and the two derivations must reconcile (the ADR's no-drift guard). Oldest first.
 */
export async function openDirectedLedger(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<ActDelivery[]> {
  const rows = await db.all<MessageRow>(
    `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND (m.act IN ('request_help','handoff')
               OR (m.to_kind = 'member' AND json_extract(m.meta, '$.urgent') = 1))
          AND m.act NOT IN ('accept','decline','resolve')
          ${undischargedSql('m', 'm.to_member')}
        ORDER BY m.ts ASC`,
    [teamId],
  );
  if (rows.length === 0) return [];
  const tallies = await auditTallies(db, teamId);
  return Promise.all(rows.map((m) => actDeliveryOf(db, m, now, tallies)));
}
