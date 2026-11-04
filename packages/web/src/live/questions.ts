import type { Envelope, LaneBoard } from '@musterd/protocol';
import { isQuestion, type Question } from '@musterd/protocol/wire';

/**
 * A seat's open question to a person (ADR 773), as the asks rail reads it (lane 01M6EP0ZR9: one
 * surface) — derived from the firehose the page already holds, the same way `deriveAsks` derives the
 * asks. One row per question: `deriveAsks` skips anything `isQuestion` says is a question.
 */
export interface QuestionCard {
  id: string;
  asker: string;
  /** The person it was put to, or null when it was put to the whole team (`audience: 'team'`). */
  to: string | null;
  question: Question;
  askedAt: number;
  waitedMs: number;
  /** The lane it is about, when the question named one and the board knows it. */
  laneTitle: string | null;
  /** The answer has not reached the seat yet. The firehose does not carry delivery today, so this is
   *  false until the daemon stamps it; the card's amber state is ready for when it does. */
  undelivered: boolean;
  env: Envelope;
}

function questionOf(env: Envelope): Question | null {
  if (env.act !== 'ask' || !isQuestion(env.meta)) return null;
  const q = env.meta?.['question'] as Partial<Question> | undefined;
  if (!q || typeof q.text !== 'string' || q.text.length === 0) return null;
  return {
    text: q.text,
    why: typeof q.why === 'string' ? q.why : undefined,
    options: Array.isArray(q.options) ? q.options.filter((o) => typeof o?.label === 'string') : undefined,
    context: q.context,
    blocking: q.blocking === true,
    audience: q.audience === 'team' ? 'team' : 'addressee',
    inferred: q.inferred === true,
  };
}

/**
 * Every question still open in the firehose, oldest first, whoever it was put to. A question settles
 * for good on the first `accept` carrying `meta.answer` that replies to it — answered anywhere — or
 * when its asker `resolve`s it (withdrawn).
 */
function openQuestions(envelopes: readonly Envelope[]): { env: Envelope; q: Question }[] {
  const open = new Map<string, { env: Envelope; q: Question }>();
  const closed = new Set<string>();
  const byTs = [...envelopes].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  for (const env of byTs) {
    const q = questionOf(env);
    if (q) {
      if (!closed.has(env.id) && !open.has(env.id)) open.set(env.id, { env, q });
      continue;
    }
    const ref = env.meta?.['in_reply_to'] ?? env.meta?.['ask_ref'] ?? env.thread;
    if (typeof ref !== 'string') continue;
    const answered = env.act === 'accept' && env.meta?.['answer'] != null;
    const withdrawn = env.act === 'resolve' && open.get(ref)?.env.from === env.from;
    if (answered || withdrawn) {
      open.delete(ref);
      closed.add(ref);
    }
  }
  return [...open.values()];
}

/** The open questions `me` may answer, oldest first: put to them by name, or to the whole team (and
 *  not asked by them). */
export function deriveQuestions(
  envelopes: readonly Envelope[],
  me: string,
  now: number,
  board: LaneBoard | null = null,
): QuestionCard[] {
  const cards: QuestionCard[] = [];
  for (const { env, q } of openQuestions(envelopes)) {
    const to = env.to.kind === 'member' ? env.to.name : null;
    const forMe = to === me || (q.audience === 'team' && env.from !== me);
    if (!forMe) continue;
    const laneId = q.context?.lane;
    const lane = laneId ? board?.lanes.find((l) => l.id === laneId || l.id.startsWith(laneId)) : undefined;
    cards.push({
      id: env.id,
      asker: env.from,
      to,
      question: q,
      askedAt: env.ts,
      waitedMs: Math.max(0, now - env.ts),
      laneTitle: lane?.title ?? null,
      undelivered: false,
      env,
    });
  }
  return cards;
}

/** Who a seat is waiting on, and for how long. `to` null means the whole team. */
export interface Waiting {
  to: string | null;
  waitedMs: number;
}

/**
 * Each asker's oldest open question, whoever is reading (lane 01M6M6G228): the team column says
 * "waiting on nick" on the asker's card or offline row. ADR 792 holds a seat's shift wakes while it
 * waits on its own question, so without this the room read an idle seat as merely on shift.
 */
export function waitingOn(envelopes: readonly Envelope[], now: number): Map<string, Waiting> {
  const out = new Map<string, Waiting>();
  for (const { env } of openQuestions(envelopes)) {
    if (out.has(env.from)) continue;
    out.set(env.from, {
      to: env.to.kind === 'member' ? env.to.name : null,
      waitedMs: Math.max(0, now - env.ts),
    });
  }
  return out;
}

/** A wait as the list reads it: `now`, `2m`, `1h`, `3d`. */
export function waitedLabel(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
