import type { Envelope, MemberSummary } from '@musterd/protocol';
import type { AskView } from './asks';
import { REPLY_FOOTER } from './promptAct';

/**
 * The composer's thread panel (lane 01M4KY55N1, alfie's steers 01M4H7F9KB / 01M4H7PHC9): after nick
 * sends, the room's replies come back INTO the chat instead of scattering across the office and the
 * log. A pure fold over the timeline the page already holds — backfill, the firehose, the composer's
 * own acks and the own-echo poll — so there is no new endpoint and no new state on the daemon.
 *
 * Why not `deriveHuddles`: it gathers a huddle by `thread === root` only, and that misses a real reply.
 * In rehearsal 1 ghost answered with `thread: null` and `meta.in_reply_to: <root>`, so the huddle read
 * counted 3 of 4 and ghost looked silent. Here a row belongs to the thread when EITHER field names the
 * root.
 */

/** How long after it opened a thread still comes back on a reload. Older ones stay in the log. */
export const THREAD_RECENT_MS = 60 * 60_000;

export type SeatState = 'replied' | 'waking' | 'here';

export interface ThreadLine {
  env: Envelope;
  /** Not on the thread: a cast seat wrote to the viewer directly while the thread was open. */
  direct: boolean;
}

export interface ComposerThread {
  root: Envelope;
  /** What the viewer typed, without the routing footer the composer appends. */
  sentence: string;
  /** Who was asked, in the order they were named. */
  cast: string[];
  /** Replies and the viewer's own follow-ups, oldest first. Asks are not here; they are in `asks`. */
  lines: ThreadLine[];
  /** Asks raised on the thread, each with its state from the asks fold. */
  asks: AskView[];
  /** Cast seats that have written anything to the thread. */
  answered: Set<string>;
  closed: boolean;
}

function meta(e: Envelope): Record<string, unknown> {
  return (e.meta ?? {}) as Record<string, unknown>;
}

/** A huddle the viewer opened, from the composer or from `musterd huddle open` alike. */
export function isViewerHuddle(e: Envelope, viewer: string): boolean {
  return e.from === viewer && e.act === 'message' && !e.thread && meta(e).huddle != null;
}

/** Who a huddle root asked: its eligible set, else the one seat it is addressed to. */
export function castOf(root: Envelope): string[] {
  const eligible = meta(root).eligible;
  if (Array.isArray(eligible)) return eligible.filter((n): n is string => typeof n === 'string');
  return root.to.kind === 'member' ? [root.to.name] : [];
}

/** True when a row answers `rootId`, by thread or by `in_reply_to` (ghost's shape). */
export function onThread(e: Envelope, rootId: string): boolean {
  return e.id !== rootId && (e.thread === rootId || meta(e).in_reply_to === rootId);
}

/**
 * The thread the panel shows: the viewer's newest huddle, if it was opened recently (`THREAD_RECENT_MS`)
 * or is still open and was not dismissed. A reload in the middle of a demo brings the same thread back.
 */
export function latestThreadRoot(
  envelopes: readonly Envelope[],
  viewer: string,
  now: number,
  dismissed: ReadonlySet<string> = new Set(),
): Envelope | null {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const e = envelopes[i]!;
    if (!isViewerHuddle(e, viewer)) continue;
    if (dismissed.has(e.id) || now - e.ts > THREAD_RECENT_MS) return null;
    return e;
  }
  return null;
}

/**
 * `asks` is the route's own asks fold, passed in rather than re-derived here: importing `asks.ts`
 * into this lazy chunk split it out of /live's eager graph into a chunk of its own, and that extra
 * chunk alone broke the initial-JS budget.
 */
export function composerThread(
  envelopes: readonly Envelope[],
  root: Envelope,
  viewer: string,
  asks: readonly AskView[] = [],
): ComposerThread {
  const cast = castOf(root);
  const inCast = new Set(cast);
  const lines: ThreadLine[] = [];
  const answered = new Set<string>();
  const askIds = new Set<string>();
  let closed = false;
  for (const e of envelopes) {
    if (e.ts < root.ts || e.id === root.id) continue;
    const threaded = onThread(e, root.id);
    // A cast seat writing to the viewer directly while the thread is open still belongs here. Before
    // the reply footer, two of four seats answered nick this way, and the panel should not lose them.
    const direct =
      !threaded &&
      !closed &&
      inCast.has(e.from) &&
      e.to.kind === 'member' &&
      e.to.name === viewer &&
      (e.act === 'message' || e.act === 'ask');
    if (!threaded && !direct) continue;
    if (e.act === 'resolve') {
      closed = true;
      continue;
    }
    if (e.act === 'ask') {
      askIds.add(e.id);
      if (inCast.has(e.from)) answered.add(e.from);
      continue;
    }
    // Status pings and the viewer's answer acts are not lines of conversation, and a seat that only
    // posted one has not answered.
    if (e.act !== 'message' && e.act !== 'request_help' && e.act !== 'handoff') continue;
    if (!e.body.trim()) continue;
    if (inCast.has(e.from)) answered.add(e.from);
    lines.push({ env: e, direct });
  }
  return {
    root,
    sentence: sentenceOf(root.body),
    cast,
    lines,
    asks: asks.filter((a) => askIds.has(a.env.id)),
    answered,
    closed,
  };
}

/** The viewer's words as typed: the composer's routing footer is plumbing, not part of the sentence. */
export function sentenceOf(body: string): string {
  const cut = body.lastIndexOf(REPLY_FOOTER);
  return (cut === -1 ? body : body.slice(0, cut)).trim();
}

/**
 * What the avatar stack says about one seat. `waking` only when it is honest: the seat has not answered
 * yet, the thread is still open, and it is either not in the room or in it only because a wake brought
 * it there (ADR 131). A seat that is simply here and reading says nothing extra.
 */
export function seatState(
  name: string,
  thread: Pick<ComposerThread, 'answered' | 'closed'>,
  member: MemberSummary | undefined,
): SeatState {
  if (thread.answered.has(name)) return 'replied';
  if (thread.closed || !member) return 'here';
  // `wokenSeat`'s reading, inlined: importing it here split it out of /live's eager chunk into one of
  // its own, and that one extra chunk alone broke the initial-JS budget. Same rule: the live row's
  // stamped provenance, never inferred.
  const live = member.presences?.find((p) => p.status === 'online' || p.status === 'away');
  if (member.presence === 'offline' || live?.provenance === 'wake') return 'waking';
  return 'here';
}

/** The quiet count under the thread, in alfie's words. */
export function answeredLine(thread: Pick<ComposerThread, 'answered' | 'cast'>): string {
  const n = thread.cast.filter((c) => thread.answered.has(c)).length;
  return `${n} of ${thread.cast.length} have answered`;
}

/**
 * The answer an inline ask card sends, in the same shape as AsksStrip's `answer`, so either surface
 * closes the same ask the same way.
 */
export function askAnswer(
  ask: AskView,
  kind: 'accept' | 'decline' | 'deciding',
  /** The picked option of a choice (`choiceReply`, lane 01M511XNQC): the record names it. */
  body?: string,
): { act: Envelope['act']; to: Envelope['to']; thread: string; body?: string; meta: Record<string, unknown> } {
  const to = { kind: 'member', name: ask.env.from } as const;
  const thread = ask.env.thread ?? ask.env.id;
  return kind === 'deciding'
    ? { act: 'wait', to, thread, body: 'deciding — check back in 1h', meta: { ask_ref: ask.env.id, until: '1h' } }
    : { act: kind, to, thread, ...(body ? { body } : {}), meta: { in_reply_to: ask.env.id } };
}
