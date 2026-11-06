import type { AppMember, AppMoment } from '@musterd/protocol/app-channel';

/**
 * The live floor at the top of Now (ADR 819, the alive design): who sits at a desk, what their
 * bubble says, and which landings get a glow. Pure, so the screen only draws it.
 */

/** At most this many desks; the rest are "+N" at the edge. */
export const FLOOR_MAX = 8;
/** One bubble change at most this often (the motion budget: nothing loops faster). */
export const BUBBLE_MS = 4_000;
/** A working member's bubble is the lane title, cut to this many characters. */
const BUBBLE_CHARS = 28;

/** The eight most recently active present members (lane time newest first, else roster order). */
export function floorDesks(present: readonly AppMember[]): { desks: AppMember[]; more: number } {
  const ranked = present
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const as = a.m.since;
      const bs = b.m.since;
      if (as !== null && bs !== null && as !== bs) return bs - as;
      if (as !== null && bs === null) return -1;
      if (as === null && bs !== null) return 1;
      return a.i - b.i;
    })
    .map(({ m }) => m);
  return {
    desks: ranked.slice(0, FLOOR_MAX),
    more: Math.max(0, ranked.length - FLOOR_MAX),
  };
}

/**
 * One short line over a desk. `askingYou` is whether this member has something in your For you:
 * then the bubble says so, in mustard. Between tasks and away say nothing.
 */
export function bubbleText(
  m: AppMember,
  askingYou: boolean,
): { text: string; mine: boolean } | null {
  switch (m.state) {
    case 'asking':
      return askingYou ? { text: 'asking you →', mine: true } : { text: m.label, mine: false };
    case 'working': {
      const t = (m.title ?? '').trim();
      if (!t) return { text: m.label, mine: false };
      return {
        text: t.length > BUBBLE_CHARS ? `${t.slice(0, BUBBLE_CHARS - 1).trimEnd()}…` : t,
        mine: false,
      };
    }
    case 'review':
      return { text: 'waiting for review', mine: false };
    case 'blocked':
      return { text: 'blocked', mine: false };
    default:
      return null;
  }
}

/**
 * The landings and finished goals in `next` that `prev` did not have, oldest first. On the first
 * load (`prev` null) nothing: no celebration for what you were not there for.
 */
export function newLandings(
  prev: readonly AppMoment[] | null,
  next: readonly AppMoment[],
): AppMoment[] {
  if (prev === null) return [];
  const seen = new Set(prev.map((m) => m.id));
  return next
    .filter((m) => (m.kind === 'landed' || m.kind === 'goal') && !seen.has(m.id))
    .sort((a, b) => a.ts - b.ts);
}

/** Whose desk glows next, one per landing in order; a member's back-to-back landings glow once. */
export function glowQueue(landings: readonly AppMoment[]): string[] {
  const out: string[] = [];
  for (const m of landings) if (out[out.length - 1] !== m.member) out.push(m.member);
  return out;
}

/**
 * What a moment row says (the alive design's table): a landing or a finished goal is a full row
 * that leads with who and carries the lane or the outcome; everything else is one quiet line.
 */
export function momentWords(m: AppMoment): {
  lead: string;
  line: string;
  full: boolean;
  accepted: boolean;
} {
  const title = m.lane?.title ?? '';
  switch (m.kind) {
    case 'landed':
      return { lead: `${m.member} landed`, line: title, full: true, accepted: m.accepted === true };
    case 'goal':
      return {
        lead: `${m.member} finished ${m.goal ?? 'a goal'}`,
        line: m.text ?? '',
        full: true,
        accepted: false,
      };
    case 'started':
      return { lead: `${m.member} started`, line: title, full: false, accepted: false };
    case 'verdict':
      return {
        lead: `${m.member} ${m.accepted ? 'accepted' : 'sent back'} your lane`,
        line: title,
        full: false,
        accepted: m.accepted === true,
      };
    case 'poll':
      return {
        lead: `${m.member} opened a poll`,
        line: m.text ?? '',
        full: false,
        accepted: false,
      };
    case 'said':
      return { lead: m.member, line: m.text ?? '', full: false, accepted: false };
  }
}
