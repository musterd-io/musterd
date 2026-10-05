/**
 * Disputes (ADR 505) — one lifecycle for contesting a claim, whatever its source.
 *
 * A dispute is anything that contests a claim a seat put on the record: a reviewer's `decline` on a
 * `lane_review` ask, a `challenge`, a failed re-check of a dependency. The source is a FIELD on the
 * act that opens it, never a kind of its own: the daemon stamps `meta.dispute = { via, … }` at
 * route time (server-controlled, like `lane_review` — a client copy is stripped), and every reader
 * — the pinned-inbox SELECT, the MCP pin predicate, `team_next`, the readout — derives from that one
 * stamp. No dispute table.
 *
 * What the stamp buys: a review rejection becomes an OBLIGATION on the lane's owner (ADR 429's
 * class), which `decline` on its own never is — an answer is not owed an answer. So the pin rule
 * gains exactly one clause, spelled once here for both readers, the way `OBLIGATION_ACTS_*` already
 * are: a directed `decline` whose stamp says `via: 'review'`.
 *
 * Validator-free (like `acts.wire.ts`) so the browser can read the vocabulary without zod — the
 * one import below is type-only and erased.
 */
import type { BuiltOn } from './lanes.js';

/** Where a dispute came from — ADR 505 §2. `dependency` is a `challenge` whose sender owns a lane
 *  that builds on one the recipient owns (derived from `depends_on`, never declared). */
export const DISPUTE_VIAS = ['review', 'challenge', 'dependency'] as const;
export type DisputeVia = (typeof DISPUTE_VIAS)[number];

/** The server-stamped `meta.dispute`. `lane`/`ask` name the review the rejection answered (`via:
 *  'review'`); `lane`/`on` name the dependent lane and the one it builds on (`via: 'dependency'`). */
export interface DisputeMeta {
  via: DisputeVia;
  lane?: string;
  ask?: string;
  on?: string;
}

/** The one `via` whose act is otherwise an answer, not an obligation. Named so the SQL and the
 *  in-memory predicate below cannot spell it differently. */
export const REVIEW_DISPUTE_VIA: DisputeVia = 'review';

/** Read a stamp back off an act's meta; null when the act opens no dispute. Tolerant of an older
 *  daemon that never stamped (absent → null, never a throw). */
export function disputeOf(meta: unknown): DisputeMeta | null {
  if (!meta || typeof meta !== 'object') return null;
  const d = (meta as { dispute?: unknown }).dispute;
  if (!d || typeof d !== 'object') return null;
  const via = (d as { via?: unknown }).via;
  if (typeof via !== 'string' || !(DISPUTE_VIAS as readonly string[]).includes(via)) return null;
  const out: DisputeMeta = { via: via as DisputeVia };
  for (const k of ['lane', 'ask', 'on'] as const) {
    const v = (d as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * A review rejection — the `decline` an acceptor sent on a `lane_review` ask, now owed an answer
 * by the lane's owner (ADR 505 §3). Directed by construction (the reviewer answers the asker), so
 * the caller's `directed` is the same `to.kind === 'member'` test `isObligationAct` takes.
 */
export function isReviewDispute(act: string, directed: boolean, meta: unknown): boolean {
  return directed && act === 'decline' && disputeOf(meta)?.via === REVIEW_DISPUTE_VIA;
}

/** Owner's answer to a review dispute (ADR 505 §3): `accept` concedes, `decline` holds. */
export type DisputeVerdict = 'conceded' | 'held';

/** What the daemon did with the owner's answer, reported on the send ack (as `lane_verdict` is). */
export interface DisputeAnswerWire {
  lane: string;
  verdict: DisputeVerdict;
  /** On a hold: the second reviewer the lane was re-routed to, or null when nobody could be
   *  picked (the lane stays active and the hold stands on the record). Absent on a concession. */
  tiebreak?: { reviewer: string; grade: string } | null;
}

/**
 * Compose the owner's-answer ack — one text, every surface (the `laneVerdictAck` argument: a
 * sentence two surfaces must agree on is protocol, not presentation).
 */
export function disputeAnswerAck(a: DisputeAnswerWire): { lane: string; guidance: string } {
  if (a.verdict === 'conceded') {
    return {
      lane: a.lane,
      guidance:
        `Lane ${a.lane}: concession recorded (ADR 505). Fix it, then resubmit — ` +
        `the review verdict is still the reviewer's to give.`,
    };
  }
  if (a.tiebreak) {
    return {
      lane: a.lane,
      guidance:
        `Lane ${a.lane} → awaiting_acceptance: your hold is on the record and the disagreement ` +
        `went to ${a.tiebreak.reviewer} (${a.tiebreak.grade}) for a tiebreak — their verdict closes it.`,
    };
  }
  return {
    lane: a.lane,
    guidance:
      `Lane ${a.lane}: your hold is on the record, but no second reviewer could be picked ` +
      `right now — the lane stays active. Resubmit when one is live, or ask a human.`,
  };
}

/**
 * ADR 505 §6 — the line under what a seat is about to build on. No gate on whether the check was
 * run (a gate on prose is a gate that gets gamed, ADR 476); the cost of not checking is measured
 * later, by the traceback (§7). One sentence, every surface.
 */
export const BUILD_ON_CHECK =
  'You are building on these (ADR 505 §6). If one carries weight for your work, re-run its check ' +
  'before you build on it — the outcome, PR and acceptor note above are where to start. If it ' +
  'fails, dispute it to its owner with `challenge` (reply_to the act).';

/** One finished dependency, one line: id, title, how it closed, the acceptor's words. */
export function builtOnLine(b: BuiltOn): string {
  const pr = b.merged?.pr !== undefined ? `, PR #${String(b.merged.pr)}` : '';
  const closed =
    b.closed_by !== undefined
      ? `, closed by ${b.closed_by} (${b.verified ? 'accepted' : 'unconfirmed'})`
      : '';
  const note = b.note ? `: "${b.note}"` : '';
  return `${b.lane} "${b.title}" — ${b.state}${pr}${closed}${note}`;
}

/** What the daemon returns when an `accept` answered a `handoff` act (ADR 505 §6): the note the
 *  sender rode on the transfer, so the receiver reads the claim it is taking on where it accepts. */
export interface AcceptedHandoffWire {
  lane?: string;
  branch?: string | null;
  note: string;
}

export function acceptedHandoffAck(h: AcceptedHandoffWire): string {
  const where = h.lane ? `lane ${h.lane}${h.branch ? ` (branch ${h.branch})` : ''}` : 'the handoff';
  const note = h.note.trim();
  const head = note.length > 240 ? `${note.slice(0, 240)}…` : note;
  return (
    `Taking ${where}. The sender's note is a claim about the work: "${head}" — re-run what it ` +
    `asserts before you build on it; if it fails, dispute it (\`challenge\`, reply_to the handoff) ` +
    `(ADR 505 §6).`
  );
}

/**
 * The tiebreak notice appended to the second reviewer's ask body (ADR 505 §4): they judge the
 * DISAGREEMENT — the rejection note against the hold — not the whole lane again.
 */
export function tiebreakNotice(firstReviewer: string, owner: string): string {
  return (
    ` TIEBREAK (ADR 505): ${firstReviewer} rejected this lane and ${owner} HELD with evidence — ` +
    `both are in this thread. Judge that disagreement, not the whole lane: \`accept\` if the hold ` +
    `stands, \`decline\` if the rejection does. Your verdict settles it.`
  );
}
