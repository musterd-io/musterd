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
      // A choice settles on the option picked (lane 01M511XNQC): "nick chose C", not "approved".
      return ask.chose ? `${by} chose ${ask.chose} ✓` : `${by} approved ✓`;
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

/** One option of an ask that is a choice: its key as the asker wrote it (`A`, `2`) and its text. */
export interface AskChoice {
  key: string;
  text: string;
}

/**
 * An ask that is a choice, read from its body (lane 01M511XNQC). On 2026-10-15 nick approved a consult
 * from the rail that offered options A–D: the rail had hidden the gist, Approve sent an empty accept,
 * and the asker read that click as option C. So a choice must be recognisable before anything can
 * answer it.
 *
 * A choice is a run of two or more option lines — `A.`, `A)`, `(a)`, `1.`, `1)`, optionally after a
 * `-`/`*` bullet — each starting its own line, in order from `A` or `1`. A line that continues an
 * option (no marker of its own) joins it. "I recommend C" / "recommend option C" names the asker's
 * pick. Prose that merely contains "a." is not a choice: the marker must open the line.
 */
export function askChoices(
  body: string,
): { options: AskChoice[]; recommended: string | null; question: string } | null {
  const MARK = /^\s*(?:[-*•]\s*)?\(?([A-Za-z]|\d{1,2})[.)]\s+(.+)$/;
  const options: AskChoice[] = [];
  let open: AskChoice | null = null;
  let firstOption = -1;
  const lines = body.split('\n');
  // Quoted passages are someone ELSE's words (lane 01M5AVXZ9B): a human-acceptance ask quotes the
  // peer's review verbatim, and a review that says "(1) … (2) … (3) …" on its own lines is findings,
  // not options. A line that opens inside an unclosed quote therefore never starts or joins a run.
  let quoted = false;
  for (const [n, line] of lines.entries()) {
    const insideQuote = quoted;
    for (const ch of line) if (ch === '"' || ch === '“' || ch === '”') quoted = !quoted;
    const m = insideQuote ? null : MARK.exec(line);
    const key = m ? m[1]!.toUpperCase() : null;
    const expected = options.length === 0 ? null : nextKey(options[options.length - 1]!.key);
    if (m && key !== null && (options.length === 0 ? key === 'A' || key === '1' : key === expected)) {
      open = { key, text: m[2]!.trim() };
      if (options.length === 0) firstOption = n;
      options.push(open);
    } else if (open && line.trim() !== '' && !m) {
      // A wrapped option: its next line has no marker. A blank line or the asker's own prose ends it —
      // prose is told apart by not being indented when the option lines were not.
      if (/^\s/.test(line)) open.text = `${open.text} ${line.trim()}`;
      else open = null;
    } else {
      open = null;
    }
  }
  if (options.length < 2) return null;
  const rec = /\brecommend(?:s|ed)?\s+(?:option\s+)?\(?([A-Za-z]|\d{1,2})\)?\b/i.exec(body);
  const recommended = rec ? rec[1]!.toUpperCase() : null;
  // The question is what comes before the options: a choice card shows it, and the option cards carry
  // the rest, so nobody reads the options twice.
  const question = lines.slice(0, firstOption).join(' ').replace(/\s+/g, ' ').trim();
  return { options, recommended: options.some((o) => o.key === recommended) ? recommended : null, question };
}

/**
 * The choices of an ask as the rail, the card and the composer must all read them: by its body,
 * EXCEPT for a lane review (`meta.lane_review` — an acceptance ask, ADR 202/603), whose only answers
 * are accept and decline. On 2026-10-19 a human-acceptance ask to nick quoted the peer's three
 * numbered findings and the rail offered them as "pick one" (lane 01M5AVXZ9B).
 */
export function askChoicesOf(env: {
  body?: string | null | undefined;
  meta?: Record<string, unknown> | null | undefined;
}): ReturnType<typeof askChoices> {
  if (env.meta && env.meta['lane_review'] !== undefined && env.meta['lane_review'] !== null) return null;
  return askChoices(env.body ?? '');
}

function nextKey(key: string): string {
  return /\d/.test(key) ? String(Number(key) + 1) : String.fromCharCode(key.charCodeAt(0) + 1);
}

/** The reply a pick sends: the option itself, so the thread records WHICH option, not just "accept". */
export function choiceReply(option: AskChoice): string {
  return `${option.key} — ${option.text}`;
}
