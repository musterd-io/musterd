import type { Envelope } from '@musterd/protocol';

/**
 * The demo prompt bar's one decision (lane 01M4H4ARQC, Demo Day 2026-10-09): what a typed request
 * becomes on the wire. It mirrors `musterd huddle open --topic design:demo --anchor … --to
 * dolly,big-body,ghost,wanderer --turns 40 "<request>"` (packages/cli/src/commands/huddle.ts), so the
 * bar and the CLI fallback send the same envelope shape. Pure, so the shape is pinned by a test.
 */

/** The demo's cast, in the order the chips show them. */
export const CAST = ['dolly', 'big-body', 'ghost', 'wanderer'] as const;

/** An eligible set holds at most four (the CLI's MAX_ELIGIBLE). */
export const MAX_CAST = 4;

export const DEMO_ANCHOR = 'docs/demo/demo-day-2026-10-09/rehearsal-log.md';

/**
 * Appended to a huddle's body, after a blank line (alfie, from nick's first rehearsal): opened with the
 * bare sentence, two of four seats answered in the thread and at least one answered nick directly,
 * because nothing said where to reply. Verbatim; never shown in the input or the success line.
 */
export const REPLY_FOOTER =
  "Reply in this thread (team_send with thread = this act's id), not as a direct message. If you need nick, send an ask in this thread.";

/** The CLI's default room pattern (`<whiteboard base>/b/huddle-<id>`); the whiteboard is not part of
 *  the demo, so nothing opens it — HuddleMetaSchema only needs a valid URL. */
const WHITEBOARD_BASE = 'http://127.0.0.1:4851';

export type PromptAct = {
  act: Envelope['act'];
  to: Envelope['to'];
  body: string;
  meta: Record<string, unknown>;
};

/**
 * Always a huddle — what `musterd huddle open` sends. Two to four on: on the team with that eligible
 * set (the CLI's `--to a,b,c`). One on: addressed to that seat (`--to ghost`). It has to be a huddle
 * even for one: the wake rail starts a sleeping seat only for interrupt-class acts, and a plain
 * directed message is not one — nick's first one-seat send sat unread in ghost's inbox (2026-10-09).
 * None on, or no text: nothing to send.
 */
export function promptAct(text: string, on: readonly string[], roomId: string): PromptAct | null {
  const body = text.trim();
  const cast = on.slice(0, MAX_CAST);
  if (!body || cast.length === 0) return null;
  const huddle = {
    topic: { kind: 'design', id: 'demo' },
    room: `${WHITEBOARD_BASE}/b/huddle-${roomId.toLowerCase()}`,
    anchor: DEMO_ANCHOR,
    budget: { turns: 40 },
  };
  return {
    act: 'message',
    to: cast.length === 1 ? { kind: 'member', name: cast[0]! } : { kind: 'team' },
    body: `${body}\n\n${REPLY_FOOTER}`,
    meta: cast.length === 1 ? { huddle } : { huddle, eligible: [...cast] },
  };
}

export { promptBarFlag, promptBarVisible } from './promptGate';

/**
 * Who hears it, from the composer's @-picker: nobody picked is "@team", which convenes the four-seat
 * demo set exactly as the first bar did (the set is no longer shown); picking narrows it — one name is
 * a huddle with that seat, two to four a huddle on those (`promptAct` decides the shape by the count).
 */
export function audienceFor(picked: readonly string[]): string[] {
  return picked.length === 0 ? [...CAST] : picked.slice(0, MAX_CAST);
}
