import type { Envelope } from '@musterd/protocol';
import { eligibleOf } from '@musterd/protocol/wire';
import { laneEvent, laneEventDetail } from './format';
import type { CaptionTone } from './captions';

/**
 * One line per notable act, built from names and lane titles — never from the act body (spec §5,
 * falsifier 3). The headline ticker under the room reads it, and lane 4's walk tags read the same
 * function, so the room and the band say the same thing about the same moment.
 *
 * The one exception is an ask's question: that is the point of an ask, and it is clipped to a line.
 *
 * Sibling of `captions.ts`: the caption is a transient sentence about a moment ("ryder is handing
 * work to dolly"); a headline is the record of it ("ryder handed Grok hook fix to dolly") and
 * carries structure the ticker chips and the tags need — who, verb, object, target.
 */
export type HeadlineTone = CaptionTone | 'lane';

export interface Headline {
  id: string;
  ts: number;
  who: string;
  /** Past-tense or present, one verb phrase: "handed", "picked up", "is asking". */
  verb: string;
  /** What the verb applies to — a lane title, "work", or the ask's clipped question. Null for verbs
   *  that take a target only ("redirected izzo"). */
  object: string | null;
  /** Whom it involves — the recipient, or whose work — with its joining word ("to dolly", "izzo's"). */
  target: string | null;
  tone: HeadlineTone;
  /** How many like it this one stands for after `collapseHeadlines` (1 = itself). */
  count: number;
}

export interface HeadlineContext {
  /** A lane's title by id — the board the page already holds. Null when unknown. */
  laneTitle: (id: string) => string | null;
}

/** 30s — the window in which "opened a", "opened b", "opened c" is one act of opening lanes. */
export const COLLAPSE_MS = 30_000;
const QUESTION_MAX = 72;

function recipient(env: Envelope): string | null {
  if (env.to.kind === 'member') return env.to.name;
  const eligible = eligibleOf(env.meta);
  if (eligible && eligible.length > 1) {
    return `${eligible.slice(0, -1).join(', ')} or ${eligible[eligible.length - 1]}`;
  }
  return null;
}

function oneLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > QUESTION_MAX ? `${t.slice(0, QUESTION_MAX - 1).trimEnd()}…` : t;
}

export function headline(env: Envelope, ctx: HeadlineContext): Headline | null {
  const base = { id: env.id, ts: env.ts, who: env.from, count: 1 };
  const say = (
    verb: string,
    object: string | null,
    target: string | null,
    tone: HeadlineTone,
  ): Headline => ({
    ...base,
    verb,
    object,
    target,
    tone,
  });
  const to = recipient(env);
  const lane = laneEvent(env);
  if (lane) {
    const detail = laneEventDetail(env);
    const bag = (env.meta?.[lane] ?? null) as { lane?: string; state?: string } | null;
    const title = detail?.title ?? (bag?.lane ? ctx.laneTitle(bag.lane) : null) ?? 'work';
    switch (lane) {
      case 'lane_handoff':
        return to ? say('handed', title, `to ${to}`, 'handoff') : null;
      case 'lane_claim':
        return say('picked up', title, null, 'lane');
      case 'lane_open':
        return say('opened', title, null, 'lane');
      case 'lane_resolve':
        return say('closed', title, null, 'accept');
      case 'lane_state':
        if (bag?.state === 'awaiting_acceptance') return say('sent', title, 'for review', 'lane');
        if (bag?.state === 'blocked') return say('is blocked on', title, null, 'ask');
        return null;
    }
  }
  switch (env.act) {
    case 'handoff':
      return to ? say('handed', 'work', `to ${to}`, 'handoff') : null;
    case 'accept':
      return to ? say('accepted', `${to}'s work`, null, 'accept') : null;
    case 'decline':
      return to ? say('sent', `${to}'s work`, 'back', 'steer') : null;
    case 'request_help':
      return to ? say('asked', to, 'for help', 'ask') : null;
    case 'ask': {
      if (!to) return null;
      // A lane-review ask is composed by the daemon (ADR 192): its body opens with a machine
      // prefix and the lane title in quotes. Say what it is rather than print the prefix
      // (dolly, lane-2 acceptance).
      const review = /^\[lane\] acceptance requested: "([^"]+)"/.exec(env.body);
      if (review) return say('asked', to, `to accept ${review[1]}`, 'ask');
      const q = oneLine(env.body);
      return say('is asking', q ? `${to}: ${q}` : to, null, 'ask');
    }
    case 'steer':
      return to
        ? say('redirected', to, null, 'steer')
        : say('redirected', 'the team', null, 'steer');
    case 'resolve':
      return to
        ? say('resolved', 'the thread', `with ${to}`, 'accept')
        : say('resolved', 'the thread', null, 'accept');
    default:
      return null;
  }
}

/**
 * The verb tag a walker wears while a purposeful walk is in flight (ADR 464 §3.2) — the same
 * pattern as the ticker's line, present tense because the walk is happening now:
 * "handing off → dolly" · "asking for help" · "redirecting izzo". One home with `headline()`, so
 * the band and the room say the same thing about the same act.
 */
export function walkTag(
  kind: 'handoff' | 'help' | 'steer' | 'claim' | 'pin' | 'submit',
  to: string | null,
): string {
  switch (kind) {
    case 'pin':
      // `to` is the lane's title: what they are carrying back to the board as finished.
      return to ? `finished ${to}` : 'finished a lane';
    case 'submit':
      return to ? `submitting ${to}` : 'submitting a lane';
    case 'claim':
      // `to` is the lane's title here: what they are on their way to pick up.
      return to ? `claiming ${to}` : 'claiming a lane';
    case 'handoff':
      return to ? `handing off → ${to}` : 'handing off';
    case 'help':
      return 'asking for help';
    case 'steer':
      return to ? `redirecting ${to}` : 'redirecting';
  }
}

/** The headline as one sentence — the ticker's text and the walk tag's. */
export function headlineText(h: Headline): string {
  if (h.count > 1) return `${h.who} ${h.verb} ${h.count} ${plural(h)}`;
  return [h.who, h.verb, h.object, h.target].filter(Boolean).join(' ');
}

function plural(h: Headline): string {
  switch (h.verb) {
    case 'opened':
    case 'picked up':
    case 'closed':
      return 'lanes';
    case 'handed':
      return 'handoffs';
    case 'accepted':
      return 'pieces of work';
    default:
      return 'times';
  }
}

/**
 * Adjacent headlines from one actor with one verb inside {@link COLLAPSE_MS} fold into a count —
 * "ryder opened 5 lanes" rather than five chips that say the same thing. Oldest first in, same out.
 */
export function collapseHeadlines(list: readonly Headline[]): Headline[] {
  const out: Headline[] = [];
  for (const h of list) {
    const last = out[out.length - 1];
    if (last && last.who === h.who && last.verb === h.verb && h.ts - last.ts <= COLLAPSE_MS) {
      out[out.length - 1] = { ...last, ts: h.ts, id: h.id, count: last.count + 1 };
    } else {
      out.push({ ...h });
    }
  }
  return out;
}
