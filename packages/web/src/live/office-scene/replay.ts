import type { Envelope } from '@musterd/protocol';
import { actToEvent } from './mapping';
import type { OfficeEvent } from './types';

/**
 * Replay on open (nick, 2026-10-12): the room only moves on acts that arrive while someone is
 * watching, so a viewer who opens /live between acts sees a still life — the claim walk shipped on
 * 10-09 and nick had never seen it. On mount, the lane walks of the last `windowMs` are played once,
 * in order, at `REPLAY_TEMPO`× the walk speed (2×: at 4× a board trip was ~2s and nick missed it,
 * 2026-10-12), and the room settles to live.
 *
 * Only the WALKS replay — claim, pin, handoff — because they are what the room does that nothing else
 * on the page shows. Speech, captions, cues and the asks' hands stay live-only: a replayed bubble
 * would say a 9-minute-old sentence as if it were now, and the stream beside the room already holds
 * the text. Pure: the scene's handle plays what this returns.
 */
export const REPLAY_WINDOW_MS = 10 * 60_000;
/** At most this many walks replay — a busy morning is a sample, not a queue (the actors cap pending walks at 3 a head anyway). */
export const REPLAY_MAX = 8;
/** The replay's speed over the live walk speed. */
export const REPLAY_TEMPO = 2;

export type ReplayEvent = Extract<OfficeEvent, { kind: 'walk-claim' | 'walk-pin' | 'walk-handoff' }>;

export function replayEvents(
  envelopes: readonly Envelope[],
  liveIds: ReadonlySet<string>,
  now: number,
  windowMs = REPLAY_WINDOW_MS,
  max = REPLAY_MAX,
): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  const since = now - windowMs;
  const sorted = [...envelopes].filter((e) => !liveIds.has(e.id) && e.ts >= since).sort((a, b) => a.ts - b.ts);
  for (const e of sorted) {
    const ev = actToEvent(e);
    if (ev && (ev.kind === 'walk-claim' || ev.kind === 'walk-pin' || ev.kind === 'walk-handoff')) out.push(ev);
  }
  // The newest `max`, still oldest-first: what the room was doing just before you arrived.
  return out.length > max ? out.slice(out.length - max) : out;
}
