import type { Lane, LaneState, MemberSummary } from '@musterd/protocol';
import {
  APP_FOR_YOU_MAX,
  APP_FOR_YOU_SUMMARY_MAX,
  APP_ROSTER_MAX,
  type AppForYou,
  type AppMember,
  type AppMemberState,
} from '@musterd/protocol/app-channel';
import { shortModel } from '@musterd/protocol/model';

/**
 * The team for the phone (ADR 814 decision 2), folded by the rule /live's team column uses
 * (`packages/web/src/live/teamCards.ts`): the same six states, the same words, the same order. Pure,
 * so each state has a fixture; `buildAppRoster` does the reads. /live folds client-side from its own
 * timeline, so this is a second copy of one rule: a state the two disagree on is a bug in whichever
 * moved last (ADR 814 Consequences).
 */

const IN_FLIGHT: readonly LaneState[] = ['claimed', 'active', 'blocked', 'awaiting_acceptance'];
const ORDER: Record<AppMemberState, number> = {
  working: 0,
  review: 1,
  blocked: 2,
  asking: 3,
  between: 4,
  away: 5,
};
const LABEL: Record<AppMemberState, string> = {
  working: 'working on',
  review: 'waiting for review',
  blocked: 'blocked on',
  asking: 'asking',
  between: 'between tasks',
  away: 'away',
};

const recency = (l: Lane) => l.claimed_at ?? l.updated_at;

/** /live's `waitedLabel`: "now", "42m", "3h", "2d". */
function waited(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** /live's model badge label, lower-case: the live attachment's model, "human", or "model unknown". */
function modelLabel(m: MemberSummary): string {
  if (m.kind === 'human') return 'human';
  const p =
    m.presences?.find((x) => x.status === 'online' || x.status === 'away') ?? m.presences?.[0];
  return shortModel(p?.model) || 'model unknown';
}

export interface AppMembersInput {
  /** The roster as /live reads it (`summarize`): presence, posture, status, attachments. */
  roster: readonly MemberSummary[];
  /** The team's lanes; only in-flight ones count. */
  lanes: readonly Lane[];
  goals: readonly { id: string; title: string }[];
  /** Each member's freshest open ask to a person or the team: what makes a card say "asking nick". */
  asking: ReadonlyMap<string, { to: string | null }>;
  /** Each member's oldest open question (ADR 806): "waiting on nick · 42m". */
  waiting: ReadonlyMap<string, { to: string | null; since: number }>;
  /** What the seat roster already knows per agent: woken by a host, its portrait digest. */
  seats: ReadonlyMap<string, { wakeable: boolean; portrait: string | null }>;
  now: number;
}

export function appMembers(input: AppMembersInput): AppMember[] {
  const owned = new Map<string, Lane[]>();
  for (const l of input.lanes) {
    if (l.owner_seat === null || !IN_FLIGHT.includes(l.state)) continue;
    const list = owned.get(l.owner_seat);
    if (list) list.push(l);
    else owned.set(l.owner_seat, [l]);
  }
  for (const list of owned.values()) list.sort((a, b) => recency(b) - recency(a));
  // The goal's NAME: titles read "Name — what it promises", and the card names the goal, it does
  // not retell it (teamCards.ts, slop tell 8).
  const goalName = new Map(
    input.goals.map((g) => [g.id, g.title.split(' — ')[0]!.trim()] as const),
  );

  const rows = input.roster
    .filter((m) => m.kind === 'agent' || m.kind === 'human')
    .map((m): AppMember => {
      const lanes = owned.get(m.name) ?? [];
      const shown = lanes[0];
      const asking = input.asking.get(m.name);
      const wait = input.waiting.get(m.name);
      const present = m.presence !== 'offline';
      const state: AppMemberState =
        !present || m.posture === 'away'
          ? 'away'
          : shown?.state === 'awaiting_acceptance'
            ? 'review'
            : shown?.state === 'blocked'
              ? 'blocked'
              : asking || wait
                ? 'asking'
                : shown
                  ? 'working'
                  : 'between';
      const label =
        state !== 'asking'
          ? LABEL[state]
          : wait && !asking
            ? `waiting on ${wait.to ?? 'the team'} · ${waited(Math.max(0, input.now - wait.since))}`
            : `asking ${asking?.to ?? 'the team'}`;
      const status = m.state?.trim() ? m.state.trim() : null;
      const seat = input.seats.get(m.name);
      return {
        name: m.name,
        kind: m.kind === 'human' ? 'human' : 'agent',
        state,
        label,
        title: shown ? shown.title : status,
        source: shown ? 'lane' : status ? 'status' : null,
        goal: shown?.goal_id ? (goalName.get(shown.goal_id) ?? null) : null,
        since: shown ? recency(shown) : null,
        more_lanes: Math.max(0, lanes.length - 1),
        model: modelLabel(m),
        online: present,
        wakeable: seat?.wakeable ?? false,
        // The seat roster's rule (ADR 791): its one live lane, or none when it holds zero or several.
        lane: lanes.length === 1 ? { id: shown!.id, title: shown!.title } : null,
        portrait: seat?.portrait ?? null,
        ...(wait ? { waiting: wait } : {}),
      };
    });

  rows.sort((a, b) => {
    const byState = ORDER[a.state] - ORDER[b.state];
    if (byState !== 0) return byState;
    const byKind = (a.kind === 'human' ? 1 : 0) - (b.kind === 'human' ? 1 : 0);
    if (byKind !== 0) return byKind;
    if (a.since !== null && b.since !== null && a.since !== b.since) return b.since - a.since;
    return a.name.localeCompare(b.name);
  });
  return rows.slice(0, APP_ROSTER_MAX);
}

export interface ForYouSource {
  id: string;
  from: string;
  kind: AppForYou['kind'];
  body: string;
  ts: number;
}

/** What waits on the binding's person (ADR 814 decision 3): oldest first, one line each, at most 32. */
export function appForYou(items: readonly ForYouSource[]): AppForYou[] {
  return [...items]
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    .slice(0, APP_FOR_YOU_MAX)
    .map((i) => {
      const line = i.body.replace(/\s+/g, ' ').trim();
      return {
        id: i.id,
        from: i.from,
        kind: i.kind,
        summary:
          line.length > APP_FOR_YOU_SUMMARY_MAX
            ? `${line.slice(0, APP_FOR_YOU_SUMMARY_MAX - 1).trimEnd()}…`
            : line,
        ts: i.ts,
      };
    });
}
