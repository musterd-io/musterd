/**
 * What discharges a directed act — named ONCE, as SQL, for every reader that asks (ADR 434).
 *
 * Four readers asked "is this act still owed?" and each spelled the answer itself: the inbox's
 * pinned set (ADR 429, `listInbox`), the open-loops gauge (`countOpenLoops`), the open directed
 * ledger that feeds the batched wake lane (`openDirectedLedger`), and the per-recipient ledger
 * (`answerBy`) whose `answered` state the wake derivation reads. Three of them knew two shapes —
 * an `accept`/`decline` naming the act, a `resolve` on its thread — and only the pinned set knew a
 * third, the recipient's own reply by `in_reply_to` on any act. None knew the fourth: the recipient
 * replying IN THE THREAD, which is how a seat answers a threaded steer.
 *
 * Measured 2026-09-21 (lane 01M32V416B): ryder answered stanley's steer 01M32R78FE in its thread at
 * 13:21:44, and the wake edge — reading a predicate that did not know that shape — leased her for
 * it again at 13:37:25. gptbot answered izzo's urgent steer 01M1T4GV18 by `message` with
 * `in_reply_to` at 13:19 and 13:43; the ledger's `answered` knew only accept/decline, so the act
 * was leased at 13:18, 13:37 and 13:42 and then declared exhausted.
 *
 * The four shapes, for an act `a` owed to recipient `r`:
 *   1. any seat's `accept`/`decline` with `meta.in_reply_to = a.id` (ADR 254: first answer wins);
 *   2. a `resolve` whose thread is `a`'s thread — `COALESCE(a.thread_id, a.id)` (ADR 025);
 *   3. `r`'s own act, whatever it is, with `meta.in_reply_to = a.id` (doorbell clause 7(iv));
 *   4. `r`'s own act, whatever it is, in `a`'s thread and newer than `a` — receipt order,
 *      `(created_at, id)`, the position every cursor here walks.
 *
 * Shapes 3 and 4 need a recipient; for a `@team` act (`to_member` NULL) they are simply never true,
 * which is right — an eligible-set act is discharged by 1 for everyone (ADR 254), not by one
 * seat's chatter. A read that has its recipient in hand passes a bound parameter (`?`); one that
 * reads the whole team passes the act's own `to_member` column.
 *
 * `messages.created_at` is compared, not `ts`: `ts` is the sender's clock and travels (ADR 335);
 * receipt order is the one every read cursor already agrees on.
 */

/** The `NOT EXISTS (...)` clauses that keep an undischarged act, to append to a `WHERE` whose
 *  act row is `alias` and whose recipient is the SQL expression `recipient` (a `?` or a column). */
export function undischargedSql(alias: string, recipient: string): string {
  return `
    AND NOT EXISTS (${answeredByAnyoneSql(alias)})
    AND NOT EXISTS (${resolvedThreadSql(alias)})
    AND NOT EXISTS (${repliedByRecipientSql(alias, recipient)})`;
}

/** Shape 1 — `SELECT 1` form. */
export function answeredByAnyoneSql(alias: string): string {
  return `SELECT 1 FROM messages dr
     WHERE dr.team_id = ${alias}.team_id
       AND dr.act IN ('accept','decline')
       AND dr.in_reply_to = ${alias}.id`;
}

/** Shape 2 — `SELECT 1` form. */
export function resolvedThreadSql(alias: string): string {
  return `SELECT 1 FROM messages dv
     WHERE dv.team_id = ${alias}.team_id
       AND dv.act = 'resolve'
       AND dv.thread_id = COALESCE(${alias}.thread_id, ${alias}.id)`;
}

/** Shapes 3 and 4 — `SELECT 1` form; the inner alias is `dy` so a caller can select from it. */
export function repliedByRecipientSql(alias: string, recipient: string): string {
  return `SELECT 1 FROM messages dy WHERE ${repliedByRecipientWhere(alias, recipient)}`;
}

/** The WHERE body of shapes 3 and 4 over a reply row aliased `dy`. `answerBy` (delivery.ts) restates
 *  it as two separately indexable queries so it can seek; a change to the predicate changes both. */
export function repliedByRecipientWhere(alias: string, recipient: string): string {
  return `dy.team_id = ${alias}.team_id
       AND dy.from_member = ${recipient}
       AND (
         dy.in_reply_to = ${alias}.id
         OR (
           dy.thread_id = COALESCE(${alias}.thread_id, ${alias}.id)
           AND (dy.created_at > ${alias}.created_at
                OR (dy.created_at = ${alias}.created_at AND dy.id > ${alias}.id))
         )
       )`;
}

/**
 * ADR 667: an ADVISORY acceptance ask is not discharged by its lane closing. The advisory seat is
 * often the slower reviewer (a 4B seat ran 50–60 s per act), so the binding verdict can land first; discharging on close
 * would leave the seat nothing to answer and starve the measure its scope exists to take. It is
 * discharged by its own answer, like any ask.
 *
 * The fifth shape, for the two acts a lane's own lifecycle answers (lane 01M4YYQCAP):
 *   5a. an acceptance `ask` (`meta.lane_review.lane`) whose lane has LEFT awaiting_acceptance — some
 *       seat's accept/decline moved it, or it was reopened; either way this ask asks nothing now;
 *   5b. a `handoff` (`meta.lane_handoff.lane`) whose lane is out of play — submitted or terminal.
 *       A handoff is discharged by DOING THE WORK (`handoffNamedLaneOutOfPlay`), never by a reply.
 *
 * Both were already derived after load in the inbox handler (`discharged: lane_closed`), which is
 * right for the rendered view and too late for the wire: the pinned set had already carried the
 * row, so a closed acceptance ask re-entered every bounded read and ADR 287's cursor could not pass
 * it. Measured 2026-10-14 (alfie): one seat's inbox showed the same eight months-old asks at the
 * top of every read, 15.5k unread behind them.
 *
 * Shape 5c (lane 01M5G34H, ADR 688): a pull announcement (`meta.pull.lane`) whose lane is claimed
 * or no longer `open`. The window's resolve is what discharges it when the host seat can still
 * speak; the asks that outlived a lane done on 2026-10-20 had no resolve (the host seats had
 * left, and a read does not discharge an obligation), so they re-entered every bounded inbox.
 * An unknown lane keeps the ask owed, same as 5a — a replica that has not seen the lane yet must
 * not drop it.
 *
 * Same narrowness as the app-level twins: an UNKNOWN lane keeps the act owed (no row, no match),
 * and a lane that returns to play makes it owed again on the next read — derived, never stored.
 * Only the structured spelling is read here; a handoff naming its lane in prose stays with the
 * handler's prose resolver.
 */
export function laneSettledSql(alias: string): string {
  return `
    AND NOT EXISTS (SELECT 1 FROM lanes ln
      WHERE ln.team_id = ${alias}.team_id
        AND (
          (${alias}.act = 'ask'
             AND ln.id = json_extract(${alias}.meta, '$.lane_review.lane')
             AND json_extract(${alias}.meta, '$.lane_review.advisory') IS NULL
             AND ln.state NOT IN ('awaiting_acceptance','ready_for_review'))
          OR (${alias}.act = 'handoff'
             AND ln.id = json_extract(${alias}.meta, '$.lane_handoff.lane')
             AND ln.state IN ('awaiting_acceptance','ready_for_review','done','abandoned'))
          OR (${alias}.act = 'ask'
             AND ln.id = json_extract(${alias}.meta, '$.pull.lane')
             AND (ln.owner_seat IS NOT NULL OR ln.state <> 'open'))
        ))`;
}
