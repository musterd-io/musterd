/**
 * The dispute readout (ADR 505 §8) — one set of numbers over the acts already stored, shared by the
 * report projection (`deriveDisputes`, server) and `scripts/research/sycophancy-readout.ts`
 * (ADR 481: one copy, so a later read measures what an earlier one did; changing a definition
 * here is a protocol change and names its ADR). It replaces ADR 476 §4's two source-split
 * channels — `challenge` and the five-phrase `phrase` proxy — with one lifecycle:
 *
 *   claim → dispute (via: review | challenge | dependency) → conceded | held → tiebreak on a hold
 *
 * WHAT IS A DISPUTE. An act that contests a claim, read off the daemon's stamp (`meta.dispute`,
 * ADR 505 inc 2) — and, for acts that predate the stamp, derived by the same rule the daemon uses:
 * a `challenge` act is `via: challenge`; a `decline` answering an ask that carries `lane_review`
 * is `via: review`. The phrase proxy is gone: a prose concession with no dispute behind it is not
 * measurable honestly (five phrases, 2 hits in 424 replies, defeated by rewording).
 *
 * WHAT IS AN ANSWER. The first `accept` (conceded) or `decline` (held) replying to the dispute
 * from a seat other than the one who opened it. "Named a check" is `namesCheck` on that body —
 * ADR 476 §4's floor on "verified", not a judgment of quality.
 *
 * WHAT IS A TIEBREAK. A `lane_review` ask carrying `tiebreak {rejection, hold, first_reviewer}`
 * (ADR 505 §4), joined to its dispute by `rejection`; its first `accept` means the hold stood, its
 * first `decline` means the rejection did. These three — correct hold, wrong hold, and (in the
 * ledger, not here) the concession later falsified — are what "selective or just stubborn" is
 * read from. The ledger half lives in files, so only the script reports it.
 *
 * NO BARE RATES (ADR 294 §4). Every number carries its denominator and its `via`; a per-seat
 * share is never a score, and `fmtShare` prints a percentage only at n ≥ 5.
 */
import { z } from 'zod';
import { DISPUTE_VIAS, disputeOf, type DisputeVia } from './dispute.js';

/** One stored act as the two loaders hand it over (strings parsed by {@link toDisputeRow}). */
export interface DisputeRow {
  id: string;
  /** The author's seat name and kind. */
  seat: string;
  kind: string;
  act: string;
  body: string;
  meta: Record<string, unknown> | null;
  inReplyTo: string | null;
  /** The act this one replies to, when loaded. */
  parentAct: string | null;
  parentMeta: Record<string, unknown> | null;
  ts: number;
}

/** The raw shape both SQL loaders produce — meta columns still JSON text. */
export interface RawDisputeRow {
  id: string;
  seat: string;
  kind: string;
  act: string;
  body: string;
  meta: string | null;
  inReplyTo: string | null;
  parentAct: string | null;
  parentMeta: string | null;
  ts: number;
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toDisputeRow(r: RawDisputeRow): DisputeRow {
  return { ...r, meta: parseMeta(r.meta), parentMeta: parseMeta(r.parentMeta) };
}

const ACT_ID = /\b01[0-9A-HJKMNP-TV-Z]{24}\b/;
const BACKTICKED = /`[^`\n]+`/;
/** A file with a code/doc extension, optionally `:line` — `audit.ts`, `http.ts:5728`, `a/b.md`. */
const FILE = /\b[\w./@-]*[\w-]\.(?:ts|tsx|js|mjs|cjs|json|md|sql|sh|yml|yaml|css|toml)(?::\d+)?\b/;
/** A commit sha: 7–40 hex with at least one digit and one letter, so a plain word or year never matches. */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const PR = /#\d+\b/;

/**
 * True when the body names a command, file, commit, PR, or act id — ADR 476 §4's test for "named
 * the check it ran". Backticked text counts as a command: that is how seats quote one.
 *
 * §4 also lists "number". Taken literally (any digit) it passed 5 of the 6 baseline challenge
 * concessions on 2026-09-29, including ones whose only digits were "94 ADRs" — so only
 * evidence-shaped numbers count: a sha, a `#PR`, a `file:line`. See ADR 476 Consequences.
 */
export function namesCheck(body: string): boolean {
  return (
    ACT_ID.test(body) || BACKTICKED.test(body) || FILE.test(body) || SHA.test(body) || PR.test(body)
  );
}

/**
 * The dispute an act opens, or null. The daemon's stamp first (ADR 505 inc 2); for acts that
 * predate it, the same derivation the daemon applies — so a read across the stamp's landing date
 * counts one thing.
 */
export function disputeViaOf(
  r: Pick<DisputeRow, 'act' | 'meta' | 'parentAct' | 'parentMeta'>,
): DisputeVia | null {
  const stamped = disputeOf(r.meta);
  if (stamped) return stamped.via;
  if (r.act === 'challenge') return 'challenge';
  if (r.act === 'decline' && r.parentAct === 'ask') {
    const lr = (r.parentMeta as { lane_review?: { lane?: unknown } } | null)?.lane_review;
    if (lr && typeof lr.lane === 'string') return 'review';
  }
  return null;
}

/** A tiebreak ask (ADR 505 §4): the review ask minted on a hold, naming the rejection it judges. */
export function tiebreakOf(
  r: Pick<DisputeRow, 'act' | 'meta'>,
): { rejection: string; hold: string } | null {
  if (r.act !== 'ask') return null;
  const tb = (
    r.meta as { lane_review?: { tiebreak?: { rejection?: unknown; hold?: unknown } } } | null
  )?.lane_review?.tiebreak;
  if (!tb || typeof tb.rejection !== 'string' || typeof tb.hold !== 'string') return null;
  return { rejection: tb.rejection, hold: tb.hold };
}

export const DisputeCellSchema = z.object({
  /** Disputes opened in the window. */
  opened: z.number().int(),
  /** … of which the claim's side replied `accept` or `decline`. */
  answered: z.number().int(),
  conceded: z.number().int(),
  held: z.number().int(),
  /** Answers whose body names a check (`namesCheck`) — numerator over `answered`. */
  named_check: z.number().int(),
  /** Holds that went to a second reviewer and got a verdict; `hold_stood` is the count the tiebreak
   *  sided with the owner (a correct hold). `settled - hold_stood` is the wrong-hold count. */
  tiebreak: z.object({ settled: z.number().int(), hold_stood: z.number().int() }),
});
export type DisputeCell = z.infer<typeof DisputeCellSchema>;

export const DisputeSeatSchema = z.object({
  seat: z.string(),
  answered: z.number().int(),
  named_check: z.number().int(),
  conceded: z.number().int(),
  held: z.number().int(),
});
export type DisputeSeat = z.infer<typeof DisputeSeatSchema>;

/** The report's `disputes` block (ADR 505 §8). Derived at projection time; nothing is stored. */
export const DisputeReadoutSchema = z.object({
  /** Start of the cut, epoch ms. */
  since: z.number().int(),
  total: DisputeCellSchema,
  by_via: z.object({
    review: DisputeCellSchema,
    challenge: DisputeCellSchema,
    dependency: DisputeCellSchema,
  }),
  /** Answering seats, most answers first. A share here is never a score (ADR 294 §4). */
  by_seat: z.array(DisputeSeatSchema),
});
export type DisputeReadout = z.infer<typeof DisputeReadoutSchema>;

const cell = (): DisputeCell => ({
  opened: 0,
  answered: 0,
  conceded: 0,
  held: 0,
  named_check: 0,
  tiebreak: { settled: 0, hold_stood: 0 },
});

/** Count disputes, their answers and their tiebreaks over the loaded acts. */
export function summariseDisputes(rows: readonly DisputeRow[], since: number): DisputeReadout {
  const ordered = [...rows].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byVia = { review: cell(), challenge: cell(), dependency: cell() };
  const total = cell();
  const seats = new Map<string, DisputeSeat>();

  // Disputes, by id, with who opened them.
  const disputes = new Map<string, { via: DisputeVia; opener: string; answered: boolean }>();
  for (const r of ordered) {
    const via = disputeViaOf(r);
    if (!via || r.ts < since) continue;
    disputes.set(r.id, { via, opener: r.seat, answered: false });
    byVia[via].opened++;
    total.opened++;
  }
  // Tiebreak asks, by id → the dispute they judge.
  const tiebreaks = new Map<string, { via: DisputeVia; settled: boolean }>();
  for (const r of ordered) {
    const tb = tiebreakOf(r);
    if (!tb) continue;
    const d = disputes.get(tb.rejection);
    if (d) tiebreaks.set(r.id, { via: d.via, settled: false });
  }
  // Answers: the first accept/decline on a dispute from someone other than its opener; the first
  // accept/decline on a tiebreak ask from someone other than its author.
  for (const r of ordered) {
    if ((r.act !== 'accept' && r.act !== 'decline') || !r.inReplyTo) continue;
    const d = disputes.get(r.inReplyTo);
    if (d && !d.answered && r.seat !== d.opener) {
      d.answered = true;
      const verdict = r.act === 'accept' ? 'conceded' : 'held';
      const named = namesCheck(r.body);
      for (const c of [byVia[d.via], total]) {
        c.answered++;
        c[verdict]++;
        if (named) c.named_check++;
      }
      let s = seats.get(r.seat);
      if (!s)
        seats.set(
          r.seat,
          (s = { seat: r.seat, answered: 0, named_check: 0, conceded: 0, held: 0 }),
        );
      s.answered++;
      s[verdict]++;
      if (named) s.named_check++;
      continue;
    }
    const t = tiebreaks.get(r.inReplyTo);
    if (t && !t.settled) {
      t.settled = true;
      for (const c of [byVia[t.via], total]) {
        c.tiebreak.settled++;
        if (r.act === 'accept') c.tiebreak.hold_stood++;
      }
    }
  }
  const by_seat = [...seats.values()].sort(
    (a, b) => b.answered - a.answered || a.seat.localeCompare(b.seat),
  );
  return { since, total, by_via: byVia, by_seat };
}

/** The `via` values in display order. */
export const DISPUTE_VIA_ORDER: readonly DisputeVia[] = DISPUTE_VIAS;

/** Counts always; a percentage only when n is large enough not to read as a score (ADR 294 §4). */
export function fmtShare(num: number, n: number, minN = 5): string {
  if (n === 0) return '0/0';
  const base = `${num}/${n}`;
  return n < minN ? base : `${base} = ${((100 * num) / n).toFixed(0)}%`;
}

/**
 * ADR 484 §1, widened by ADR 505 §8: the one line added to the sender's reply when an `accept`
 * concedes a DISPUTE without naming a check. Sender-only, never stored on the act.
 */
export const DISPUTE_EVIDENCE_NOTICE =
  "this concedes a dispute without naming what you checked — if you checked something, say what; if you didn't, say that";
/** @deprecated ADR 505 inc 3 — the same text under its ADR 484 name, kept one epoch for callers. */
export const CHALLENGE_EVIDENCE_NOTICE = DISPUTE_EVIDENCE_NOTICE;

/** True for an `accept` answering a dispute (stamped, or a bare `challenge`) whose body names no check. */
export function isUnverifiedDisputeAnswer(
  act: string,
  parentAct: string | null,
  parentMeta: Record<string, unknown> | null,
  body: string,
): boolean {
  if (act !== 'accept') return false;
  const opensDispute = parentAct === 'challenge' || disputeOf(parentMeta) !== null;
  return opensDispute && !namesCheck(body);
}
