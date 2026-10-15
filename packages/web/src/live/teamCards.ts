import type { Lane, LaneBoard, LaneState, MemberSummary } from '@musterd/protocol';
import { askIsLoud, type AskView } from './asks';
import { memberColor, memberPosture } from './format';

/**
 * The team column's pure view-model (ADR 464, spec §4). One card per PRESENT member, ordered by
 * what a room watching the screen most needs to see first: who is working, then who is waiting on
 * a reviewer, then who is stuck, then who is between tasks, then who stepped away. Humans sit last
 * within their group — the agents are the show; the humans are the audience's way in.
 *
 * Sibling of `workingOn.ts` (the /broadcast reel), not a replacement: that one answers "what is
 * the room doing" as a list of titles; this one answers "who is this person" as a card.
 */
export type CardState = 'working' | 'review' | 'blocked' | 'asking' | 'between' | 'away';

export interface TeamCard {
  name: string;
  kind: 'agent' | 'human';
  color: string;
  member: MemberSummary;
  state: CardState;
  /** "working on" · "waiting for review" · "blocked on" · "asking nick" · "between tasks" · "away". */
  stateLabel: string;
  /** The shown lane's title, else the member's own status line, else null. */
  title: string | null;
  source: 'lane' | 'status' | null;
  /** The shown lane's goal title, when it names one. */
  goal: string | null;
  /** The shown lane's derived or declared areas (ADR 582 §3). */
  areas: readonly string[];
  /** `claimed_at` (else `updated_at`) of the shown lane — what `elapsed` ages against. */
  since: number | null;
  /** Other in-flight lanes this member owns, beyond the one shown. */
  moreLanes: number;
}

const IN_FLIGHT: readonly LaneState[] = ['claimed', 'active', 'blocked', 'awaiting_acceptance'];
const ORDER: Record<CardState, number> = {
  working: 0,
  review: 1,
  blocked: 2,
  asking: 3,
  between: 4,
  away: 5,
};
const LABEL: Record<CardState, string> = {
  working: 'working on',
  review: 'waiting for review',
  blocked: 'blocked on',
  asking: 'asking',
  between: 'between tasks',
  away: 'away',
};

const recency = (l: Lane) => l.claimed_at ?? l.updated_at;

function stateOf(m: MemberSummary, lane: Lane | undefined, asking: AskView | undefined): CardState {
  if (memberPosture(m) === 'away') return 'away';
  if (lane?.state === 'awaiting_acceptance') return 'review';
  if (lane?.state === 'blocked') return 'blocked';
  // An open ask to a person outranks the lane it is about (ADR 464 §4): the room should see that
  // this member is waiting on someone, which is what their work is actually doing.
  if (asking) return 'asking';
  if (lane) return 'working';
  return 'between';
}

export function teamCards(
  roster: MemberSummary[],
  board: LaneBoard | null,
  goals: readonly { id: string; title: string }[],
  /** The derived asks (with the tier clock applied) — an open one to a human makes the asker's card
   *  say "asking nick". Optional: without them no card ever says it. */
  asks: readonly AskView[] = [],
): { cards: TeamCard[]; offline: number } {
  // The freshest open ask per asker that is addressed to a HUMAN (or the team). An agent-routed
  // review ask is a review, not a room moment — the same line the banner draws.
  const humans = new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name));
  const askingBy = new Map<string, AskView>();
  for (const a of asks) {
    if (!askIsLoud(a.state)) continue;
    if (a.to !== null && !humans.has(a.to)) continue;
    const had = askingBy.get(a.env.from);
    if (!had || a.env.ts > had.env.ts) askingBy.set(a.env.from, a);
  }
  const owned = new Map<string, Lane[]>();
  for (const l of board?.lanes ?? []) {
    if (l.owner_seat === null || !IN_FLIGHT.includes(l.state)) continue;
    const list = owned.get(l.owner_seat);
    if (list) list.push(l);
    else owned.set(l.owner_seat, [l]);
  }
  for (const list of owned.values()) list.sort((a, b) => recency(b) - recency(a));
  // The goal's NAME: titles read "Name — what it promises", and the card names which goal a lane
  // serves, it does not retell it (slop tell 8 — under every member on that goal, it was 3 lines).
  const goalTitle = new Map(goals.map((g) => [g.id, g.title.split(' — ')[0]!.trim()] as const));

  const present = roster.filter((m) => m.presence !== 'offline');
  const cards = present.map((m): TeamCard => {
    const kind = m.kind === 'human' ? 'human' : 'agent';
    const lanes = owned.get(m.name) ?? [];
    const lane = lanes[0];
    const status = m.state?.trim() ? m.state.trim() : null;
    const asking = askingBy.get(m.name);
    const state = stateOf(m, lane, asking);
    return {
      name: m.name,
      kind,
      color: memberColor(m.name, kind, m.hue),
      member: m,
      state,
      stateLabel: state === 'asking' ? `asking ${asking?.to ?? 'the team'}` : LABEL[state],
      title: lane ? lane.title : status,
      source: lane ? 'lane' : status ? 'status' : null,
      goal: lane?.goal_id ? (goalTitle.get(lane.goal_id) ?? null) : null,
      areas: lane?.areas ?? [],
      since: lane ? recency(lane) : null,
      moreLanes: Math.max(0, lanes.length - 1),
    };
  });

  cards.sort((a, b) => {
    const byState = ORDER[a.state] - ORDER[b.state];
    if (byState !== 0) return byState;
    const byKind = (a.kind === 'human' ? 1 : 0) - (b.kind === 'human' ? 1 : 0);
    if (byKind !== 0) return byKind;
    if (a.since !== null && b.since !== null && a.since !== b.since) return b.since - a.since;
    return a.name.localeCompare(b.name);
  });
  return { cards, offline: roster.length - present.length };
}

/** "42m" / "3h" / "2d" — how long the shown lane has been in hand. */
export function elapsed(since: number | null, now: number): string | null {
  if (since === null) return null;
  const min = Math.floor((now - since) / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
