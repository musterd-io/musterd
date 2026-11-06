import type { AppForYou, AppMember, AppMemberState } from '@musterd/protocol/app-channel';
import type { Roster } from './quickAction';

/**
 * The Now screen's view of the roster (ADR 814): who is present and in what state, who is away,
 * and what waits on the viewer. A pure fold, so the screen only draws it.
 */
export type { AppForYou, AppMember, AppMemberState };
/** An ask the phone holds itself (a push that reached it), reduced to what For you needs. */
export interface OwnAsk {
  id: string;
  from: string;
  ts: number;
  summary: string;
}

export interface TeamRows {
  /** Members in the room, in the daemon's order (/live's: working, review, blocked, asking, between). */
  present: AppMember[];
  /** Away members: wakeable agents first, then the other agents, then people. */
  offline: AppMember[];
  /** Everything waiting on the viewer, oldest first: the daemon's list and the phone's own, by id. */
  forYou: AppForYou[];
  counts: { here: number; offline: number; needYou: number };
}

/** /live's `byReach`: wakeable agents (they have a button), then the other agents, then people. */
function byReach(a: AppMember, b: AppMember): number {
  const rank = (m: AppMember) => (m.kind === 'human' ? 2 : m.wakeable ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** A seat as an old daemon sends it (ADR 791), read as a member: working with a lane, else between. */
function fromSeat(seat: Roster['seats'][number]): AppMember {
  const state: AppMemberState = !seat.online ? 'away' : seat.lane ? 'working' : 'between';
  return {
    name: seat.seat,
    kind: 'agent',
    state,
    label: state === 'working' ? 'working on' : state === 'between' ? 'between tasks' : 'away',
    title: seat.lane?.title ?? null,
    source: seat.lane ? 'lane' : null,
    goal: null,
    since: null,
    more_lanes: 0,
    model: null,
    online: seat.online,
    wakeable: seat.wakeable,
    lane: seat.lane,
    portrait: seat.portrait ?? null,
    ...(seat.waiting ? { waiting: seat.waiting } : {}),
  };
}

export function teamRows(
  roster: Roster | null,
  ownAsks: readonly OwnAsk[],
  _viewer: string | null,
): TeamRows {
  const members = roster?.members ?? roster?.seats.map(fromSeat) ?? [];
  const present = members.filter((m) => m.state !== 'away');
  const offline = members.filter((m) => m.state === 'away').sort(byReach);
  const byId = new Map<string, AppForYou>();
  for (const f of roster?.for_you ?? []) byId.set(f.id, f);
  for (const a of ownAsks)
    if (!byId.has(a.id))
      byId.set(a.id, { id: a.id, from: a.from, kind: 'approve', summary: a.summary, ts: a.ts });
  const forYou = [...byId.values()].sort((a, b) => a.ts - b.ts);
  return {
    present,
    offline,
    forYou,
    counts: { here: present.length, offline: offline.length, needYou: forYou.length },
  };
}

/** "10 here · 20 offline · 2 need you" — zero parts drop out, except here. */
export function summaryLine(c: TeamRows['counts']): string {
  const parts = [`${c.here} here`];
  if (c.offline > 0) parts.push(`${c.offline} offline`);
  if (c.needYou > 0) parts.push(`${c.needYou} ${c.needYou === 1 ? 'needs' : 'need'} you`);
  return parts.join(' · ');
}

/** /live's `elapsed()`: "<1m" / "42m" / "3h" / "2d" — how long the shown lane has been in hand. */
export function sinceLabel(since: number | null, now: number): string | null {
  if (since === null) return null;
  const min = Math.floor((now - since) / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The For you header's number: the merged list it heads, never the phone's own asks alone. */
export function forYouCount(rows: TeamRows): number {
  return rows.forYou.length;
}

/** The model under a name: /live's badge for someone here; nothing for an away row (/live's fold shows none). */
export function modelLine(m: AppMember): string | null {
  return m.state === 'away' ? null : m.model;
}

/** An asker's portrait digest (ADR 797), from the roster's members present or away; null for a stranger. */
export function portraitOf(rows: TeamRows, name: string): string | null {
  return [...rows.present, ...rows.offline].find((m) => m.name === name)?.portrait ?? null;
}
