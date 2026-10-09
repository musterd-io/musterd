import type { Lane, LaneBoard, MemberSummary, Request } from '@musterd/protocol';
import { askIsLoud, type AskView } from './asks';

/**
 * The briefing: the one place the page decides what is in progress, what needs a human, what is in
 * review and what shipped. `/live`'s Now panel and `/broadcast`'s lower-third both render this, and
 * the topbar headline is built from the same four arrays — so a count can never disagree with the
 * list under it (the old meter counted a presence posture, the old team column counted lane-owning
 * cards: "1 working" over "3 working", 2026-10-09).
 *
 * Pure, over what the page already holds. Counts are **lanes**, not people; the per-member view
 * stays in `teamCards.ts`.
 *
 * Two rules keep the counts honest (measured 2026-10-09: "15 in progress" over a column saying
 * "2 working"): a lane is **in progress** only while its owner is present — a claim held by an
 * offline seat is not progress — and an ask **needs a human** only when it is team-wide or routed
 * to a human; an agent-routed review ask is a review, not a person waiting (the same line
 * `teamCards` and the asks strip draw).
 *
 * `requests` (pending seat claims) is admin-only data and is read only when the caller passes it.
 * `/broadcast` never does — a public stream does not announce who is knocking.
 */

/** A lane that reached `done` inside this window counts as shipped today. */
export const SHIPPED_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHOWN_TITLE = 90;

export type NeedsKind = 'ask' | 'approval' | 'blocked' | 'seat-request';

export interface NeedsItem {
  /** Stable React key: `ask:<envelope>` | `lane:<lane>` | `req:<request>`. */
  id: string;
  kind: NeedsKind;
  /** The ask's question (first line, clipped), the lane's title, or "wants to join as <target>". */
  title: string;
  /** Who is asking, or who owns the blocked lane. Null when nobody does. */
  owner: string | null;
  /** Whom an ask was routed to; null for a team ask and for everything that is not an ask. */
  waitingOn: string | null;
  /** When the wait began. */
  since: number;
  /** Set for `blocked`, so the surface can open the lane. */
  laneId: string | null;
  /** The raw id the surface opens: the ask's envelope id, the lane id, or the request id. */
  ref: string;
}

export interface WorkItem {
  id: string;
  title: string;
  owner: string | null;
  /** The goal's name ("Name — what it promises" → "Name"), when the lane names one. */
  goal: string | null;
  since: number;
}

export interface ShippedItem {
  id: string;
  title: string;
  by: string | null;
  at: number;
}

export interface Briefing {
  needsHuman: NeedsItem[];
  inProgress: WorkItem[];
  inReview: WorkItem[];
  shipped: ShippedItem[];
  headline: string;
}

const recency = (l: Lane) => l.claimed_at ?? l.updated_at;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => clip((s.split('\n', 1)[0] ?? '').trim(), SHOWN_TITLE);

export function briefing(input: {
  board: LaneBoard | null;
  goals: readonly { id: string; title: string }[];
  asks: readonly AskView[];
  roster: readonly MemberSummary[];
  requests?: readonly Request[];
  now: number;
}): Briefing {
  const { board, goals, asks, roster, requests = [], now } = input;
  const humans = new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name));
  const present = new Set(roster.filter((m) => m.presence !== 'offline').map((m) => m.name));
  // The item names the goal, it does not retell it (slop tell 8).
  const goalName = new Map(goals.map((g) => [g.id, g.title.split(' — ')[0]!.trim()] as const));
  const work = (l: Lane): WorkItem => ({
    id: `lane:${l.id}`,
    title: l.title,
    owner: l.owner_seat,
    goal: l.goal_id ? (goalName.get(l.goal_id) ?? null) : null,
    since: recency(l),
  });

  const lanes = board?.lanes ?? [];
  const byRecency = (a: Lane, b: Lane) => recency(b) - recency(a);
  const inProgress = lanes
    .filter(
      (l) =>
        (l.state === 'claimed' || l.state === 'active') &&
        l.owner_seat !== null &&
        present.has(l.owner_seat),
    )
    .sort(byRecency)
    .map(work);
  const inReview = lanes
    .filter((l) => l.state === 'awaiting_acceptance')
    .sort(byRecency)
    .map(work);
  const shipped = lanes
    .filter(
      (l) => l.state === 'done' && l.resolved_at !== null && now - l.resolved_at < SHIPPED_WINDOW_MS,
    )
    .sort((a, b) => b.resolved_at! - a.resolved_at!)
    .map((l): ShippedItem => ({ id: `lane:${l.id}`, title: l.title, by: l.owner_seat, at: l.resolved_at! }));

  const needsHuman: NeedsItem[] = [
    ...asks
      .filter((a) => askIsLoud(a.state) && (a.to === null || humans.has(a.to)))
      .map(
        (a): NeedsItem => ({
          id: `ask:${a.env.id}`,
          kind: a.species === 'approve' ? 'approval' : 'ask',
          title: firstLine(a.env.body),
          owner: a.env.from,
          waitingOn: a.to,
          since: a.env.ts,
          laneId: null,
          ref: a.env.id,
        }),
      ),
    ...lanes
      .filter((l) => l.state === 'blocked')
      .map(
        (l): NeedsItem => ({
          id: `lane:${l.id}`,
          kind: 'blocked',
          title: l.title,
          owner: l.owner_seat,
          waitingOn: null,
          since: recency(l),
          laneId: l.id,
          ref: l.id,
        }),
      ),
    ...requests
      .filter((r) => r.status === 'pending')
      .map(
        (r): NeedsItem => ({
          id: `req:${r.id}`,
          kind: 'seat-request',
          title: `wants to join${r.target ? ` as ${r.target.replace(/^(seat|role):/, '')}` : ''}`,
          owner: null,
          waitingOn: null,
          since: r.ts,
          laneId: null,
          ref: r.id,
        }),
      ),
  ].sort((a, b) => a.since - b.since); // longest-waiting first

  const parts = [
    inProgress.length ? `${inProgress.length} in progress` : null,
    needsHuman.length ? `${needsHuman.length} need${needsHuman.length === 1 ? 's' : ''} a human` : null,
    inReview.length ? `${inReview.length} in review` : null,
    shipped.length ? `${shipped.length} shipped today` : null,
  ].filter((p): p is string => p !== null);

  return {
    needsHuman,
    inProgress,
    inReview,
    shipped,
    headline: parts.length ? parts.join(' · ') : 'quiet — nothing in flight',
  };
}
