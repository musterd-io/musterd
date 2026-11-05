import { winnersOf, type OpenPoll, type OpenPollReply, type PollMeta } from '@musterd/protocol/wire';

/**
 * What the /broadcast poll card shows (ADR 807, lane 01M6ME5BFQ), derived from one `GET /polls/open`
 * reply and the clock. Pure, so the card is a function of data. It never carries a voter: the reply
 * holds only integer counts.
 */

/** How long the result stays on the stage after a poll closes. */
export const RESULT_SHOWN_MS = 15_000;

export interface PollRow {
  /** 1-based, the number a viewer types after `!vote`. */
  n: number;
  label: string;
  pct: number;
  lead: boolean;
}

export type PollView =
  | { kind: 'open'; id: string; question: string; rows: PollRow[]; left: string; votes: string }
  | {
      kind: 'result';
      id: string;
      question: string;
      rows: PollRow[];
      headline: string;
      votes: string;
    };

const plural = (n: number) => `${n} ${n === 1 ? 'vote' : 'votes'}`;

function rows(options: readonly string[], counts: readonly number[], voters: number): PollRow[] {
  const lead = new Set(winnersOf(counts));
  return options.map((label, i) => ({
    n: i + 1,
    label,
    pct: voters > 0 ? Math.round(((counts[i] ?? 0) / voters) * 100) : 0,
    lead: lead.has(i),
  }));
}

/** `m:ss`, never negative. */
export function timeLeft(closesAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((closesAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function openView(p: OpenPoll, now: number): PollView {
  return {
    kind: 'open',
    id: p.id,
    question: p.question,
    rows: rows(p.options, p.counts, p.voters),
    left: `${timeLeft(p.closes_at, now)} left`,
    votes: `${plural(p.voters)} · type !vote in chat`,
  };
}

function headline(r: Extract<PollMeta, { state: 'closed' }>): string {
  const pick = (i: number) => `${i + 1} · ${r.options[i]}`;
  if (r.winners.length === 0) return 'No votes this time';
  if (r.winners.length > 1) return `It’s a tie: ${r.winners.map(pick).join(' and ')}`;
  return `Winner: ${pick(r.winners[0]!)}`;
}

/**
 * The card for this reply at `now`: the open poll, or a closed poll's result for 15 s after it
 * closed, or nothing. A cancelled or interrupted poll shows no result — the bot says so in chat,
 * and a stage card announcing a non-result would only repeat it.
 */
export function pollView(reply: OpenPollReply | null, now: number): PollView | null {
  if (!reply) return null;
  if (reply.poll) return openView(reply.poll, now);
  const r = reply.last;
  if (!r || (r.end !== 'deadline' && r.end !== 'ended')) return null;
  if (now - r.closed_at >= RESULT_SHOWN_MS) return null;
  return {
    kind: 'result',
    id: r.id,
    question: r.question,
    rows: rows(r.options, r.counts, r.voters),
    headline: headline(r),
    votes: plural(r.voters),
  };
}

/** One sentence for assistive tech: what the screen says, without the ticking clock. */
export function pollSummary(v: PollView): string {
  const standings = v.rows.map((r) => `${r.n}, ${r.label}: ${r.pct}%`).join('; ');
  return v.kind === 'open'
    ? `Poll: ${v.question} ${standings}. ${v.votes.replace(' · ', '. ')}.`
    : `Poll closed: ${v.question} ${v.headline}, ${v.votes}.`;
}
