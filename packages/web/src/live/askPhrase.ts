import { ASK_TIER_DEFAULTS, type AskTier } from '@musterd/protocol/wire';
import {
  askAudience,
  askIsLoud,
  byAudienceThenUrgency,
  type AskState,
  type AskView,
  type AudienceContext,
} from './asks';

/**
 * The ask banner's words and view-model (ADR 464, spec §6). The operator vocabulary — `stranded`,
 * `risk_accepted`, `lapsed` — stays in the sheet and the log; a room reads what the words mean.
 */

/** How long a settled outcome stays on the banner before it shrinks to the idle pill. */
export const SETTLED_MS = 6_000;
const QUESTION_MAX = 96;

/** The §6 table, plus the open states that share its words. */
export function askStatePhrase(
  state: AskState,
  tier: AskTier,
  timeoutMs: number = ASK_TIER_DEFAULTS[tier].timeout_ms,
): string {
  switch (state) {
    case 'stranded':
      return 'nobody answered';
    case 'risk_accepted':
      return `went ahead after ${minutes(timeoutMs)} min`;
    case 'lapsed':
      return 'expired';
    case 'held':
      return 'holding until answered';
    case 'deferred':
      return 'put off';
    case 'open':
      return tier === 'blocking'
        ? 'holding until answered'
        : `goes ahead in ${minutes(timeoutMs)} min if unanswered`;
    case 'accepted':
      return 'approved';
    case 'declined':
      return 'said no';
    case 'resolved':
      return 'resolved';
  }
}

function minutes(timeoutMs: number): number {
  return Math.round(timeoutMs / 60_000);
}

export type AskBanner =
  | { mode: 'idle'; more: number }
  | {
      mode: 'open';
      lead: AskView;
      who: string;
      to: string | null;
      question: string;
      /** A daemon-composed lane-review ask (ADR 192): the lane's title, so the banner can say
       *  "ryder asked big-body to accept <title>" instead of printing the machine prefix. */
      reviewTitle: string | null;
      /** The hold words for right now: with a running clock, "goes ahead in 4 min if unanswered". */
      hold: string;
      /** m:ss — time left on the clock, or time elapsed while holding. */
      clock: string;
      more: number;
    }
  | {
      mode: 'settled';
      lead: AskView;
      who: string;
      to: string | null;
      outcome: string;
      more: number;
    };

/** The banner, from the asks the strip already derives (with the tier clock applied). */
export function askBanner(asks: readonly AskView[], ctx: AudienceContext, now: number): AskBanner {
  const loud = asks.filter((a) => askIsLoud(a.state)).sort(byAudienceThenUrgency(ctx, now));
  // A human's question first (Review Focus 2): an agent-routed review ask is a review, not a room
  // moment, and leads only when nothing waits on a person.
  const human = loud.filter((a) => askAudience(a, ctx) !== 'agent');
  const lead = human[0] ?? loud[0];
  if (lead) {
    const review = /^\[lane\] acceptance requested: "([^"]+)"/.exec(lead.env.body);
    return {
      mode: 'open',
      lead,
      who: lead.env.from,
      to: lead.to,
      reviewTitle: review?.[1] ?? null,
      question: review ? '' : oneLine(lead.env.body),
      hold: holdNow(lead, now),
      clock: clock(lead, now),
      more: loud.length - 1,
    };
  }
  // Settled just now: say what happened, for a few seconds, then go quiet.
  const recent = asks
    .filter(
      (a) => a.settledAt !== undefined && now - a.settledAt <= SETTLED_MS && now >= a.settledAt,
    )
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))[0];
  if (recent) {
    return {
      mode: 'settled',
      lead: recent,
      who: recent.env.from,
      to: recent.to,
      outcome: outcome(recent),
      more: 0,
    };
  }
  return { mode: 'idle', more: 0 };
}

function holdNow(ask: AskView, now: number): string {
  if (ask.state !== 'open' || ask.tier === 'blocking') return askStatePhrase(ask.state, ask.tier, ask.deadline - ask.env.ts);
  const left = Math.max(0, ask.deadline - now);
  const min = Math.ceil(left / 60_000);
  return min <= 0
    ? 'goes ahead any moment if unanswered'
    : `goes ahead in ${min} min if unanswered`;
}

/** m:ss under an hour; past it, "5h 31m" — a room does not read "331:09" (dolly, lane 3). */
function clock(ask: AskView, now: number): string {
  const ms = ask.state === 'open' && ask.deadline > now ? ask.deadline - now : now - ask.env.ts;
  const m = Math.floor(ms / 60_000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function outcome(ask: AskView): string {
  const by = ask.answeredBy ?? ask.to ?? 'someone';
  switch (ask.state) {
    case 'accepted':
      return `${by} approved ✓`;
    case 'declined':
      return `${by} said no ✗`;
    case 'deferred':
      return `${by} put it off${ask.until ? ` · back in ${ask.until}` : ''}`;
    case 'resolved':
      return `${by} resolved it`;
    default:
      return askStatePhrase(ask.state, ask.tier, ask.deadline - ask.env.ts);
  }
}

function oneLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > QUESTION_MAX ? `${t.slice(0, QUESTION_MAX - 1).trimEnd()}…` : t;
}
