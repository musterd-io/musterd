import type { AppMember, AppMoment } from '@musterd/protocol/app-channel';

/**
 * The live floor at the top of Now (ADR 819, the alive design): who sits at a desk, what their
 * bubble says, and which landings get a glow. Pure, so the screen only draws it.
 */

/** At most this many desks; the rest are "+N" at the edge. */
export const FLOOR_MAX = 8;
/** A desk's cue is the lane title, cut to this many characters (/live's work cue, phone-sized). */
const CUE_CHARS = 24;

/** What sits on a desk besides its member, as /live's desk props: the tray, the sticky, the ask. */
export type DeskProp = 'review' | 'blocked' | 'asking' | 'asking-you' | null;

export interface Desk {
  member: AppMember;
  /** What they are on, in a few words; for an ask, who it is to. */
  cue: string | null;
  prop: DeskProp;
}

function cut(t: string): string {
  return t.length > CUE_CHARS ? `${t.slice(0, CUE_CHARS - 1).trimEnd()}…` : t;
}

/**
 * The floor as /live's office lays the team out (`office-scene/seating.ts`): members with work sit
 * at desks — at most eight, most recently active first — each with what they are on and the prop
 * that says their state; members between tasks are in the lounge. `askingYou` names the members
 * with something in your For you: their desk says so, in mustard.
 */
export function officeLayout(
  present: readonly AppMember[],
  askingYou: ReadonlySet<string>,
): { desks: Desk[]; moreDesks: number; lounge: AppMember[] } {
  const working = present
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.state !== 'between' && m.state !== 'away')
    .sort((a, b) => {
      const as = a.m.since;
      const bs = b.m.since;
      if (as !== null && bs !== null && as !== bs) return bs - as;
      if (as !== null && bs === null) return -1;
      if (as === null && bs !== null) return 1;
      return a.i - b.i;
    })
    .map(({ m }): Desk => {
      const prop: DeskProp =
        m.state === 'review'
          ? 'review'
          : m.state === 'blocked'
            ? 'blocked'
            : m.state === 'asking'
              ? askingYou.has(m.name)
                ? 'asking-you'
                : 'asking'
              : null;
      const title = (m.title ?? '').trim();
      const cue =
        prop === 'asking-you'
          ? 'asking you'
          : title
            ? cut(title)
            : prop === 'asking'
              ? m.label
              : null;
      return { member: m, cue, prop };
    });
  return {
    desks: working.slice(0, FLOOR_MAX),
    moreDesks: Math.max(0, working.length - FLOOR_MAX),
    lounge: present.filter((m) => m.state === 'between'),
  };
}

/** The board's count: lanes landed today, as /live pins each to its board. */
export function landedToday(moments: readonly AppMoment[]): number {
  return moments.filter((m) => m.kind === 'landed').length;
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
