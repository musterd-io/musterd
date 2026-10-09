import type { Lane, LaneBoard, MemberSummary, Request } from '@musterd/protocol';
import { askIsLoud, type AskView } from './asks';

/**
 * The briefing: the one place the page decides what is in progress, what needs a human, what is in
 * review and what shipped. `/live`'s Now overlay reads it, and the topbar headline is built from the
 * same arrays — so a count can never disagree with the list under it (the old meter counted a
 * presence posture, the old team column counted lane-owning cards: "1 working" over "3 working",
 * 2026-10-09).
 *
 * It is the page a member opens in the morning having forgotten yesterday, so it answers three
 * things, each grouped the way that question is asked: what is on the team's plate **by goal**, what
 * is waiting **by the human who has to act**, and what landed **by who landed it**. (The Team column
 * already answers "who is on what" by person; repeating that is the failure the first version was.)
 *
 * Pure, over what the page already holds. Counts are **lanes**, not people.
 *
 * Two rules keep the counts honest (measured 2026-10-09: "15 in progress" over a column saying
 * "2 working"): a lane is **in progress** only while its owner is present — a claim held by an
 * offline seat is not progress — and an ask **needs a human** only when it is team-wide or routed
 * to a human; an agent-routed review ask is a review, not a person waiting (the same line
 * `teamCards` and the asks strip draw).
 *
 * `requests` (pending seat claims) is admin-only data and is read only when the caller passes it.
 */

/** A lane that reached `done` inside this window counts as shipped TODAY (the headline's number). */
export const SHIPPED_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHOWN_TITLE = 90;

/**
 * Where "what we did yesterday" starts: the start of the previous *working* day, in the viewer's own
 * clock. Monday morning wants Friday's work, so Saturday, Sunday and Monday reach back to Friday.
 */
export function briefingSince(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const back = [2, 3, 1, 1, 1, 1, 1][d.getDay()]!; // Sun→Fri, Mon→Fri, Tue..Fri→yesterday, Sat→Fri
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** What a human is being asked for. The words are the ask's own species, not a guess. */
export type Want = 'approval' | 'clarification' | 'an answer';
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
  /** What is being asked of the human — null for a blocked lane, which names no human. */
  want: Want | null;
  /** For a blocked lane: the first dependency still open, when one is declared. */
  waitsOn: { title: string; owner: string | null } | null;
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
  goalId: string | null;
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

/** The asks waiting on one human, headed by what they are being asked for. */
export interface NeedsGroup {
  key: string;
  /** Who has to act: a human's name, "an admin" (seat claims), or "the team" (a team-wide ask). */
  human: string;
  /** "Needs approval from nick" — built from the kinds actually in the group. */
  heading: string;
  items: NeedsItem[];
}

export interface GoalGroup {
  key: string;
  /** The goal's short name, or "No goal". */
  goal: string;
  items: WorkItem[];
}

/** One goal row on the Now card (spec, "The Now card, v2"): how far along, what is moving, who. */
export interface GoalMotion {
  key: string;
  /** Null for the "No goal" row. */
  goalId: string | null;
  /** The goal's short name ("Name — what it promises" → "Name"), or "No goal". */
  name: string;
  /** The full title, for the hover. */
  title: string;
  /** Lanes done, of all the goal's lanes but the abandoned ones. */
  done: number;
  total: number;
  working: number;
  review: number;
  blocked: number;
  /** Owners of the moving lanes, newest first, once each. */
  people: string[];
  /** The newest moving lane's time — the row order. */
  latest: number;
}

export interface ShippedGroup {
  who: string;
  items: ShippedItem[];
}

export interface Briefing {
  /** Everything that wants a human, asks and blocked lanes together — the headline's number. */
  needsHuman: NeedsItem[];
  /** The asks, approvals and seat claims, grouped under the human who has to act. */
  needsGroups: NeedsGroup[];
  /** Blocked lanes. They name no human, so they get their own header. */
  blocked: NeedsItem[];
  inProgress: WorkItem[];
  /** In progress, grouped by goal — the biggest first. */
  byGoal: GoalGroup[];
  /** Goals with something working, in review or blocked — newest first, "No goal" last. */
  goalsInMotion: GoalMotion[];
  inReview: WorkItem[];
  /** Lanes done since `shippedSince` (default: the last 24 h). */
  shipped: ShippedItem[];
  /** The same, grouped by who landed it — the most first. */
  shippedBy: ShippedGroup[];
  headline: string;
}

const recency = (l: Lane) => l.claimed_at ?? l.updated_at;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => clip((s.split('\n', 1)[0] ?? '').trim(), SHOWN_TITLE);

const WANT_ORDER: Want[] = ['approval', 'clarification', 'an answer'];

/** "approval" · "approval and clarification" · "approval, clarification and an answer". */
export function needsHeading(human: string, wants: readonly Want[]): string {
  const ws = WANT_ORDER.filter((w) => wants.includes(w));
  const list =
    ws.length <= 1 ? (ws[0] ?? 'an answer') : `${ws.slice(0, -1).join(', ')} and ${ws[ws.length - 1]}`;
  return `Needs ${list} from ${human}`;
}

const wantOf = (species: string): Want =>
  species === 'approve' ? 'approval' : species === 'consult' ? 'clarification' : 'an answer';

export function briefing(input: {
  board: LaneBoard | null;
  goals: readonly { id: string; title: string }[];
  asks: readonly AskView[];
  roster: readonly MemberSummary[];
  requests?: readonly Request[];
  now: number;
  /** Where the shipped list starts. Defaults to the last 24 h; the overlay passes `briefingSince`. */
  shippedSince?: number;
}): Briefing {
  const { board, goals, asks, roster, requests = [], now } = input;
  const shippedSince = input.shippedSince ?? now - SHIPPED_WINDOW_MS;
  const humans = new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name));
  const present = new Set(roster.filter((m) => m.presence !== 'offline').map((m) => m.name));
  // The item names the goal, it does not retell it (slop tell 8).
  const goalName = new Map(goals.map((g) => [g.id, g.title.split(' — ')[0]!.trim()] as const));
  const work = (l: Lane): WorkItem => ({
    id: `lane:${l.id}`,
    title: l.title,
    owner: l.owner_seat,
    goalId: l.goal_id,
    goal: l.goal_id ? (goalName.get(l.goal_id) ?? null) : null,
    since: recency(l),
  });

  const lanes = board?.lanes ?? [];
  const byId = new Map(lanes.map((l) => [l.id, l] as const));
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
    .filter((l) => l.state === 'done' && l.resolved_at !== null && l.resolved_at >= shippedSince)
    .sort((a, b) => b.resolved_at! - a.resolved_at!)
    .map((l): ShippedItem => ({ id: `lane:${l.id}`, title: l.title, by: l.owner_seat, at: l.resolved_at! }));

  const asked: NeedsItem[] = [
    ...asks
      .filter((a) => askIsLoud(a.state) && (a.to === null || humans.has(a.to)))
      .map(
        (a): NeedsItem => ({
          id: `ask:${a.env.id}`,
          kind: a.species === 'approve' ? 'approval' : 'ask',
          title: firstLine(a.env.body),
          owner: a.env.from,
          waitingOn: a.to,
          want: wantOf(a.species),
          waitsOn: null,
          since: a.env.ts,
          laneId: null,
          ref: a.env.id,
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
          want: 'approval',
          waitsOn: null,
          since: r.ts,
          laneId: null,
          ref: r.id,
        }),
      ),
  ].sort((a, b) => a.since - b.since); // longest-waiting first

  const blocked = lanes
    .filter((l) => l.state === 'blocked')
    .map((l): NeedsItem => {
      const dep = l.depends_on
        .map((id) => byId.get(id))
        .find((d) => d !== undefined && d.state !== 'done' && d.state !== 'abandoned');
      return {
        id: `lane:${l.id}`,
        kind: 'blocked',
        title: l.title,
        owner: l.owner_seat,
        waitingOn: null,
        want: null,
        waitsOn: dep ? { title: dep.title, owner: dep.owner_seat } : null,
        since: recency(l),
        laneId: l.id,
        ref: l.id,
      };
    })
    .sort((a, b) => a.since - b.since);

  // Under the human who has to act. A seat claim is for an admin; a team-wide ask is for the team.
  const groups = new Map<string, NeedsItem[]>();
  for (const n of asked) {
    const human = n.kind === 'seat-request' ? 'an admin' : (n.waitingOn ?? 'the team');
    const list = groups.get(human);
    if (list) list.push(n);
    else groups.set(human, [n]);
  }
  const needsGroups: NeedsGroup[] = [...groups.entries()]
    .map(([human, items]) => ({
      key: `human:${human}`,
      human,
      heading: needsHeading(
        human,
        items.map((i) => i.want ?? 'an answer'),
      ),
      items,
    }))
    .sort((a, b) => b.items.length - a.items.length || a.human.localeCompare(b.human));

  const goalGroups = new Map<string, WorkItem[]>();
  for (const w of inProgress) {
    const key = w.goal ?? '';
    const list = goalGroups.get(key);
    if (list) list.push(w);
    else goalGroups.set(key, [w]);
  }
  const byGoal: GoalGroup[] = [...goalGroups.entries()]
    .map(([goal, items]) => ({ key: `goal:${goal}`, goal: goal || 'No goal', items }))
    .sort(
      (a, b) =>
        Number(a.goal === 'No goal') - Number(b.goal === 'No goal') ||
        b.items.length - a.items.length ||
        a.goal.localeCompare(b.goal),
    );

  // A lane is "working" here exactly when it is in `inProgress`, so the rows add up to the headline.
  const working = new Set(inProgress.map((w) => w.id));
  const motion = new Map<string, { goalId: string | null; lanes: Lane[] }>();
  for (const l of lanes) {
    if (l.state === 'abandoned') continue;
    const key = l.goal_id ?? '';
    const m = motion.get(key);
    if (m) m.lanes.push(l);
    else motion.set(key, { goalId: l.goal_id, lanes: [l] });
  }
  const goalTitle = new Map(goals.map((g) => [g.id, g.title] as const));
  const goalsInMotion: GoalMotion[] = [];
  for (const [key, { goalId, lanes: ls }] of motion) {
    const isWorking = (l: Lane) => working.has(`lane:${l.id}`);
    const moving = ls
      .filter((l) => isWorking(l) || l.state === 'awaiting_acceptance' || l.state === 'blocked')
      .sort(byRecency);
    if (moving.length === 0) continue;
    const people = [...new Set(moving.map((l) => l.owner_seat).filter((o): o is string => o !== null))];
    const title = goalId ? (goalTitle.get(goalId) ?? goalId) : 'No goal';
    goalsInMotion.push({
      key: `motion:${key}`,
      goalId,
      name: goalId ? (goalName.get(goalId) ?? goalId) : 'No goal',
      title,
      done: ls.filter((l) => l.state === 'done').length,
      total: ls.length,
      working: ls.filter(isWorking).length,
      review: ls.filter((l) => l.state === 'awaiting_acceptance').length,
      blocked: ls.filter((l) => l.state === 'blocked').length,
      people,
      latest: recency(moving[0]!),
    });
  }
  goalsInMotion.sort(
    (a, b) => Number(a.goalId === null) - Number(b.goalId === null) || b.latest - a.latest,
  );

  const shippers = new Map<string, ShippedItem[]>();
  for (const s of shipped) {
    const who = s.by ?? 'someone';
    const list = shippers.get(who);
    if (list) list.push(s);
    else shippers.set(who, [s]);
  }
  const shippedBy: ShippedGroup[] = [...shippers.entries()]
    .map(([who, items]) => ({ who, items }))
    .sort((a, b) => b.items.length - a.items.length || a.who.localeCompare(b.who));

  const needsHuman = [...asked, ...blocked].sort((a, b) => a.since - b.since);
  const today = shipped.filter((s) => now - s.at < SHIPPED_WINDOW_MS).length;
  const parts = [
    inProgress.length ? `${inProgress.length} in progress` : null,
    needsHuman.length ? `${needsHuman.length} need${needsHuman.length === 1 ? 's' : ''} a human` : null,
    inReview.length ? `${inReview.length} in review` : null,
    today ? `${today} shipped today` : null,
  ].filter((p): p is string => p !== null);

  return {
    needsHuman,
    needsGroups,
    blocked,
    inProgress,
    byGoal,
    goalsInMotion,
    inReview,
    shipped,
    shippedBy,
    headline: parts.length ? parts.join(' · ') : 'quiet — nothing in flight',
  };
}

/**
 * What waits on whom, from the viewer's side (spec, "The Now card, v2"): the viewer's own asks, newest
 * first, for the band at the top of the card; everyone else's as counts for the quiet line under it.
 * A viewer who is not signed in has nothing of their own.
 */
export function waitingFor(
  brief: Pick<Briefing, 'needsGroups'>,
  viewer: string | null,
): { mine: NeedsItem[]; others: { who: string; n: number }[] } {
  const mine = viewer
    ? [...(brief.needsGroups.find((g) => g.human === viewer)?.items ?? [])].sort(
        (a, b) => b.since - a.since,
      )
    : [];
  const others = brief.needsGroups
    .filter((g) => g.human !== viewer)
    .map((g) => ({ who: g.human, n: g.items.length }));
  return { mine, others };
}
