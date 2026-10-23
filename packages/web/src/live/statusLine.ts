/**
 * A human's own status line on /live and /broadcast (ADR 721): what to show, when it lapses, and how
 * a `member_updated` push lands in the roster. Pure, so the room and the team panel agree.
 */
import type { MemberSummary } from '@musterd/protocol';

/** `STATUS_LINE_MAX` in `@musterd/protocol` (48). Copied, not imported: a value import from the protocol's
 *  root pulls zod into the /live bundle; the daemon is the authority and answers 400 past it. */
const STATUS_LINE_MAX = 48;

/** ADR 721: the status line's mark — two bulbs with caps and sand mounded in the bottom (nick picked
 *  "glass and sand" from three hourglasses as the one you can recognise at 9px). */
export const HOURGLASS_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h8M4 14h8M5 2.5c0 3 3 4 3 5.5s-3 2.5-3 5.5M11 2.5c0 3-3 4-3 5.5s3 2.5 3 5.5" stroke-width="1.5"/><path d="M5.6 13.4Q8 9.6 10.4 13.4zM6.6 4.6h2.8L8 6.4z" fill="currentColor" stroke="none"/></svg>';

export interface VisibleStatusLine {
  text: string;
  /** ms epoch — the moment the status clears on every screen at once. */
  expiresAt: number;
}

/** A human's status while it lasts; null on an agent or a service, and from its expiry on. */
export function visibleStatusLine(m: Pick<MemberSummary, 'kind' | 'status_line'>, now: number): VisibleStatusLine | null {
  const line = m.status_line;
  if (m.kind !== 'human' || !line || line.expires_at <= now) return null;
  return { text: line.text, expiresAt: line.expires_at };
}

/** The next moment a shown status lapses — when the room must redraw without any new event. */
export function nextStatusExpiry(roster: readonly MemberSummary[], now: number): number | null {
  let next: number | null = null;
  for (const m of roster) {
    const v = visibleStatusLine(m, now);
    if (v && (next === null || v.expiresAt < next)) next = v.expiresAt;
  }
  return next;
}

/** The roster with `member` in place of the row of the same name; unchanged if nobody matches. */
export function replaceMember(roster: readonly MemberSummary[], member: MemberSummary): MemberSummary[] {
  const i = roster.findIndex((m) => m.name === member.name);
  if (i < 0) return roster as MemberSummary[];
  const next = roster.slice();
  next[i] = member;
  return next;
}

/** The field as it is typed: the trimmed length in characters (an emoji is one), against the 48 cap. */
export function statusLineDraft(text: string): { count: number; ready: boolean; over: boolean } {
  const count = [...text.trim()].length;
  return { count, ready: count > 0 && count <= STATUS_LINE_MAX, over: count > STATUS_LINE_MAX };
}
