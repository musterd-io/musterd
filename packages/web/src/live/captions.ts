import type { Envelope } from '@musterd/protocol';
import { eligibleOf } from '@musterd/protocol/wire';
import { laneEvent } from './format';

/**
 * The caption rail (first-five-seconds spec §2): orientation through narration of REAL moments.
 * A stranger learns the vocabulary by watching it used — the caption and the choreography it names
 * are on screen together. Notable moments only; status chatter never captions. Pure module: the
 * DOM layer owns nothing but rendering `CaptionRail.current`.
 */

/**
 * What KIND of moment this narrates. The line already knows — it was composed from the act — and
 * throwing that away left the rail rendering every moment as identical grey italic text. The header
 * pill colours by tone, so "accepted — it's done" and "urgently needs" do not read the same
 * (nick, 2026-08-31). Five, not one-per-act: these are the families a viewer distinguishes.
 */
export type CaptionTone = 'accept' | 'ask' | 'handoff' | 'steer' | 'presence';

/**
 * A narrated moment: the sentence, whose moment it is, and what family it belongs to. `who` is the
 * ACTOR — the member whose colour the pill's dot takes, so the line ties to the same identity the
 * floor label, the roster chip and the rail dot already carry.
 */
export interface Caption {
  text: string;
  who: string;
  tone: CaptionTone;
}

/** Plain-sentence caption for a notable act — `null` for everything that should stay quiet. `answered`
 *  is the act an accept replies to (`meta.in_reply_to`), when the page holds it: an accept alone cannot
 *  say whether it closed a lane, picked an option or took a handoff (lane 01M51E333V). */
export function captionFor(env: Envelope, answered?: Envelope): Caption | null {
  const from = env.from;
  /**
   * Who the act is for, as a phrase the sentence can drop in.
   *
   * An ADR 254 eligible set travels as `to: {kind:'team'}` with the names in `meta.eligible`, so
   * reading `to` alone left the 28 review-routing `request_help`s in the live corpus with NO
   * caption at all — `if (!to) return null` swallowed the most consequential directed act the team
   * sends. `eligibleOf` is the protocol's single reader of that shape.
   */
  const eligible = eligibleOf(env.meta);
  const to =
    env.to.kind === 'member'
      ? env.to.name
      : eligible && eligible.length > 1
        ? `${eligible.slice(0, -1).join(', ')} or ${eligible[eligible.length - 1]}`
        : null;
  const say = (text: string, tone: CaptionTone): Caption => ({ text, who: from, tone });
  if (laneEvent(env) === 'lane_handoff' && to) return say(`${from} is handing work to ${to}`, 'handoff');
  switch (env.act) {
    case 'handoff':
      return to ? say(`${from} is handing work to ${to}`, 'handoff') : null;
    case 'accept':
      return to ? say(acceptLine(env, from, to, answered), 'accept') : null;
    case 'steer':
      return say(`${from} is redirecting ${to ?? 'the team'}`, 'steer');
    case 'request_help':
      if (!to) return null;
      return env.meta?.['urgent'] === true
        ? say(`${from} urgently needs ${to}`, 'ask')
        : say(`${from} is asking ${to} for help`, 'ask');
    case 'ask':
      if (!to) return null;
      return env.meta?.['species'] === 'approve'
        ? say(`${from} is asking ${to} to approve something`, 'ask')
        : say(`${from} is asking ${to} to weigh in`, 'ask');
    default:
      return null;
  }
}

/** Arrival/departure narration from the online-name diff — at most one story per refresh. */
export function captionForPresence(prev: ReadonlySet<string>, next: ReadonlySet<string>): Caption | null {
  for (const n of next) if (!prev.has(n)) return { text: `${n} just walked in`, who: n, tone: 'presence' };
  for (const n of prev) if (!next.has(n)) return { text: `${n} just stepped out`, who: n, tone: 'presence' };
  return null;
}

/** One caption at a time, ~6s hold, at most 2 queued — past that, drop rather than narrate the past. */
export interface CaptionRail {
  current: Caption | null;
  shownAt: number;
  queue: Caption[];
}

export const CAPTION_HOLD_MS = 6_000;
const QUEUE_MAX = 2;

export function pushCaption(s: CaptionRail, caption: Caption, now: number): CaptionRail {
  if (s.current === null) return { current: caption, shownAt: now, queue: [] };
  if (s.queue.length >= QUEUE_MAX) return s; // dropped — a late caption is noise, not orientation
  return { ...s, queue: [...s.queue, caption] };
}

export function tickCaption(s: CaptionRail, now: number): CaptionRail {
  if (s.current === null || now - s.shownAt < CAPTION_HOLD_MS) return s;
  const [head, ...rest] = s.queue;
  return { current: head ?? null, shownAt: now, queue: rest };
}

/**
 * What an accept accepted, in words (lane 01M51E333V). "accepted X's work — it's done" is a claim that a
 * lane was accepted, so it is said only when that is what happened: the answered ask was a lane review,
 * or the accept carries a verdict's claims (a peer's acceptance, readable even when the ask is out of
 * the window). A choice names its option; anything the page cannot see is a plain yes.
 */
function acceptLine(env: Envelope, from: string, to: string, answered: Envelope | undefined): string {
  const picked = /^([A-Z]|\d{1,2}) — /.exec(env.body ?? '');
  if (picked) return `${from} chose ${picked[1]} on ${to}'s question`;
  if (answered?.meta?.['lane_review'] || Array.isArray(env.meta?.['claims']))
    return `${from} accepted ${to}'s work — it's done`;
  if (answered?.act === 'handoff') return `${from} took on ${to}'s handoff`;
  if (answered?.act === 'request_help') return `${from} is helping ${to}`;
  if (answered?.act === 'ask') return `${from} approved ${to}'s ask`;
  return `${from} said yes to ${to}`;
}

