import type { Envelope, Lane, MemberSummary } from '@musterd/protocol';
import {
  fill,
  TOUR_LANE_TITLE,
  TOUR_STEPS,
  type TourStepId,
} from '../../content/generated/tour';

/**
 * The web tour's step machine and text (lane 01M4M4DDYF, spec docs/design/tour-web-copy.md). The CLI
 * tour is the reference: `packages/cli/src/tour/machine.ts` and `screens.ts` hold the same rules, and
 * the web cannot import them (only `@musterd/protocol` crosses a package line), so this is a port of
 * both. The copy itself is NOT ported: it comes from `content/tour.data.ts` through build-prep, so a
 * copy fix is one edit for both surfaces. Pure, so every case runs as a unit test.
 *
 * Only an act about THIS tour's lane moves it — a real team carries a steady stream of unrelated
 * acts, and any of them advancing the tour would teach the wrong thing.
 */
export type TourOutcome = 'accepted' | 'self_closed' | 'declined';

export interface TourState {
  step: TourStepId;
  me: string;
  agent: string;
  laneId?: string;
  /** The request_help the tour sent; a decline counts only if it replies to this. */
  requestId?: string;
  /** The acceptance ask routed to `me`; the verdict replies to it (ADR 202). */
  askId?: string;
  outcome?: TourOutcome;
  declineReason?: string;
  sentBack: number;
}

export type TourEvent =
  | { type: 'continue' }
  | { type: 'lane_opened'; laneId: string; requestId: string }
  | { type: 'act'; env: Envelope }
  | { type: 'verdict'; accept: boolean }
  | { type: 'skip_to_record' };

/** States a resumable tour lane can be in (spec §2); a closed one has no entry point on the web. */
const OPEN_STATES = new Set(['open', 'claimed', 'active', 'blocked', 'awaiting_acceptance']);

export function initialState(me: string, agent: string): TourState {
  return { step: 'what', me, agent, sentBack: 0 };
}

function stepOf(id: TourStepId) {
  const step = TOUR_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`unknown tour step: ${id}`);
  return step;
}

function stepAfter(id: TourStepId): TourStepId | null {
  const i = TOUR_STEPS.findIndex((s) => s.id === id);
  return TOUR_STEPS[i + 1]?.id ?? null;
}

function metaOf(env: Envelope): Record<string, unknown> {
  return (env.meta as Record<string, unknown> | null | undefined) ?? {};
}

/** The lane id inside `meta[key]` (`lane_claim`, `lane_review`, `lane_resolve`), if any. */
function metaLane(env: Envelope, key: string): string | undefined {
  const v = metaOf(env)[key];
  if (!v || typeof v !== 'object') return undefined;
  const lane = (v as { lane?: unknown }).lane;
  return typeof lane === 'string' ? lane : undefined;
}

function onAct(s: TourState, env: Envelope): TourState {
  if (!s.laneId) return s;
  const fromAgent = env.from === s.agent;

  if (s.step === 'claims') {
    if (!fromAgent || s.outcome === 'declined') return s;
    if (metaLane(env, 'lane_claim') === s.laneId) return { ...s, step: 'hands_back' };
    const declines = env.act === 'decline' || env.act === 'challenge';
    if (declines && s.requestId && metaOf(env)['in_reply_to'] === s.requestId) {
      return { ...s, outcome: 'declined', declineReason: env.body };
    }
    return s;
  }

  if ((s.step === 'hands_back' || s.step === 'judge') && fromAgent) {
    if (metaLane(env, 'lane_resolve') === s.laneId) {
      return { ...s, step: 'record', outcome: 'self_closed' };
    }
  }

  if (s.step === 'hands_back') {
    const toMe = env.to.kind === 'member' && env.to.name === s.me;
    if (env.act === 'ask' && toMe && metaLane(env, 'lane_review') === s.laneId) {
      return { ...s, step: 'judge', askId: env.id };
    }
  }
  return s;
}

/** Returns `s` itself when the event does not apply, so a caller can tell a no-op. */
export function advance(s: TourState, e: TourEvent): TourState {
  switch (e.type) {
    case 'continue': {
      const w = stepOf(s.step).wait;
      const next = stepAfter(s.step);
      return (w === 'continue' || w === 'none') && next ? { ...s, step: next } : s;
    }
    case 'lane_opened':
      return s.step === 'give_work'
        ? { ...s, step: 'claims', laneId: e.laneId, requestId: e.requestId }
        : s;
    case 'skip_to_record':
      return s.step === 'claims' && s.outcome === 'declined' ? { ...s, step: 'record' } : s;
    case 'verdict': {
      if (s.step !== 'judge') return s;
      if (e.accept) return { ...s, step: 'record', outcome: 'accepted' };
      const next: TourState = { ...s, step: 'hands_back', sentBack: s.sentBack + 1 };
      delete next.askId;
      return next;
    }
    case 'act':
      return onAct(s, e.env);
  }
}

/** The vars a step's text is filled with. `model` is '' when the harness attested none. */
export type TourVars = {
  you: string;
  agent: string;
  lane: string;
  model: string;
};

/** `Step 6 of 9 · You judge it` (spec §1). */
export function stepTitle(id: TourStepId): string {
  const index = TOUR_STEPS.findIndex((s) => s.id === id);
  return `Step ${index + 1} of ${TOUR_STEPS.length} · ${stepOf(id).title}`;
}

/** The `{verdict}` on `record`, in one of the four forms of spec §4. */
export function verdictLine(s: TourState, you: string): string {
  if (s.outcome === 'self_closed') return `closed by ${s.agent} itself`;
  if (s.outcome === 'declined') return `declined by ${s.agent}`;
  const accepted = `accepted by ${you}`;
  return s.sentBack > 0 ? `sent back by ${you}, then ${accepted}` : accepted;
}

/**
 * The step's body lines, filled. With no attested model the record line says `model unattested`;
 * on every other step a line about the model drops (spec §1, as `musterd status` does). Before an
 * agent is chosen, a line naming `{agent}` drops too: it has nothing to name yet.
 */
export function stepLines(s: TourState, v: TourVars): string[] {
  const record = s.step === 'record';
  const vars = {
    ...v,
    model: v.model || 'unattested',
    verdict: verdictLine(s, v.you),
  };
  return stepOf(s.step)
    .body.filter((line) => record || v.model !== '' || !line.includes('{model}'))
    .filter((line) => v.agent !== '' || !line.includes('{agent}'))
    .map((line) => fill(line, vars));
}

/** The latest hint due `elapsedMs` into a step, filled; null before the first. */
export function hintFor(id: TourStepId, elapsedMs: number, v: TourVars): string | null {
  const due = stepOf(id).hints.filter((h) => elapsedMs >= h.afterMs);
  const last = due[due.length - 1];
  if (!last) return null;
  // The shared hints were written for the terminal; a page has no Ctrl-C and no `musterd tour`, and
  // its own Stop and Resume buttons already say how to leave and come back.
  const web = last.text.replace(/\s*Ctrl-C[^.]*\./, '');
  return fill(web, { you: v.you, agent: v.agent, lane: v.lane });
}

/** The viewer's own tour lane, in any state — resume finds it by its exact title (spec §2). */
export function tourLaneOf(lanes: readonly Lane[], you: string): Lane | null {
  const title = fill(TOUR_LANE_TITLE, { you });
  // Newest first: after a `Start over` the abandoned lane and the fresh one share the title.
  let found: Lane | null = null;
  for (const l of lanes) if (l.title === title && (!found || l.id > found.id)) found = l;
  return found;
}

export function isOpenTourLane(lane: Lane): boolean {
  return OPEN_STATES.has(lane.state);
}

/** What the entry point offers (spec §3): nothing, a start, or a resume beside a start-over. */
export type TourEntry =
  | { kind: 'none' }
  | { kind: 'take' }
  | { kind: 'again' }
  | { kind: 'resume'; lane: Lane };

export function tourEntry(
  lanes: readonly Lane[] | null,
  roster: readonly MemberSummary[],
  you: string,
): TourEntry {
  // The verdict must come from a person (spec §2); a board not read yet offers nothing, rather than
  // a `Take the tour` that a second later turns into `Resume`.
  if (!lanes || roster.find((m) => m.name === you)?.kind !== 'human') return { kind: 'none' };
  const lane = tourLaneOf(lanes, you);
  if (lane && isOpenTourLane(lane)) return { kind: 'resume', lane };
  if (agentsOf(roster, you).length === 0) return { kind: 'none' };
  // A closed tour lane stays as the record and a new run opens a new lane (tour-web-copy.md §3, lane
  // 01M4RGKRKS): nick finished the tour once on 2026-10-12 and then could not find it again.
  return lane ? { kind: 'again' } : { kind: 'take' };
}

/** The entry button's words (tour-web-copy.md §3); null where the entry is not a start. */
export function entryLabel(entry: TourEntry): string | null {
  if (entry.kind === 'take') return 'Take the tour';
  if (entry.kind === 'again') return 'Take the tour again';
  return null;
}

export function agentsOf(roster: readonly MemberSummary[], you: string): string[] {
  return roster.filter((m) => m.kind === 'agent' && m.name !== you).map((m) => m.name);
}

/** The agent's attested model, from its first presence; '' when unknown (spec §1). */
export function modelOf(roster: readonly MemberSummary[], name: string): string {
  const model = roster.find((m) => m.name === name)?.presences?.[0]?.model?.trim() ?? '';
  return model === 'unknown' ? '' : model;
}

/** `0:47` — how long the tour has been waiting on the agent. */
export function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * What the roster says the agent is doing while the tour waits on it. A woken agent can take most
 * of a minute to start, and before this line the panel was silent for all of it (nick, 2026-10-11:
 * ghost took 47s to claim and he could not tell whether anything was happening). Only what the
 * roster asserts: a seat whose wake is not reachable right now is never called "being woken".
 */
export function agentNow(
  member: MemberSummary | undefined,
  step: TourStepId,
): string | null {
  if (!member) return null;
  const name = member.name;
  switch (readinessOf(member)) {
    case 'asleep':
      return `${name} isn't running right now, so musterd is waking it. That usually takes under a minute.`;
    case 'unreachable':
      return `${name} is offline, and musterd can't wake it from here. It will see the request when it next starts.`;
    case 'busy':
      if (step !== 'hands_back')
        return `${name} is online but busy with other work. It reads the request between tasks.`;
      break;
    case 'ready':
      if (step !== 'hands_back') return `${name} is online and has the request.`;
  }
  return `${name} is online and working on the lane. When it's done, it submits it for your review.`;
}

/** How ready an agent is to take the tour lane, best first. */
export type Readiness = 'ready' | 'busy' | 'asleep' | 'unreachable';
const READINESS_ORDER: readonly Readiness[] = ['ready', 'busy', 'asleep', 'unreachable'];

/** Only what the roster asserts: a seat whose wake cannot reach it now is never "asleep". */
export function readinessOf(member: MemberSummary | undefined): Readiness {
  if (!member) return 'unreachable';
  if (member.presence === 'offline') {
    const canWake = member.wakeability
      ? member.wakeability === 'wakeable'
      : member.wakeable === true;
    return canWake ? 'asleep' : 'unreachable';
  }
  return member.posture === 'working' || member.activity === 'working' ? 'busy' : 'ready';
}

export const READINESS_LABEL: Record<Readiness, string> = {
  ready: 'online · ready now',
  busy: 'online · busy',
  asleep: 'asleep · ~1 min to wake',
  unreachable: "offline · can't be woken",
};

/**
 * The agent the picker suggests: the readiest, roster order breaking a tie. An awake agent saves
 * the minute a wake takes, which was most of the wait on the first run (ghost, 47s, asleep).
 */
export function suggestAgent(roster: readonly MemberSummary[], agents: readonly string[]): string {
  let best = '';
  let rank = READINESS_ORDER.length;
  for (const a of agents) {
    const r = READINESS_ORDER.indexOf(readinessOf(roster.find((m) => m.name === a)));
    if (r < rank) [best, rank] = [a, r];
  }
  return best;
}

/**
 * How far the tour lane has come, as the ticket's track shows it: 0 before the lane exists, then
 * opened (1), claimed (2), submitted for review (3), closed (4). A decline stays at opened; the
 * ticket marks it on the claim stop instead.
 */
export type TicketStage = 0 | 1 | 2 | 3 | 4;

export function ticketStage(s: TourState): TicketStage {
  if (!s.laneId) return 0;
  if (s.outcome === 'accepted' || s.outcome === 'self_closed') return 4;
  if (s.step === 'judge') return 3;
  if (s.step === 'hands_back') return 2;
  return 1;
}

export interface TimelineEntry {
  id: string;
  ts: number;
  text: string;
}

/**
 * The tour lane's story so far, oldest first: the lines under the ticket that turn a wait into
 * something to watch. Built only from acts the record holds about this lane, and the agent's own
 * status lines since it opened, so the timeline never says more than the record does.
 */
export function timeline(acts: readonly Envelope[], s: TourState): TimelineEntry[] {
  const lane = s.laneId;
  if (!lane) return [];
  const opened = ulidTime(lane);
  const byId = new Map(acts.map((a) => [a.id, a]));
  const out = new Map<string, TimelineEntry>();
  const add = (e: Envelope, text: string) => out.set(e.id, { id: e.id, ts: e.ts, text });
  for (const e of acts) {
    const meta = metaOf(e);
    const reply = meta['in_reply_to'];
    if (metaLane(e, 'lane_open') === lane) add(e, 'You opened the lane');
    else if (e.id === s.requestId) add(e, `You asked ${s.agent} to take it`);
    else if (e.from === s.agent && metaLane(e, 'lane_claim') === lane) add(e, `${s.agent} claimed it`);
    else if (e.from === s.agent && e.act === 'ask' && metaLane(e, 'lane_review') === lane)
      add(e, `${s.agent} submitted it for your review`);
    else if (metaLane(e, 'lane_resolve') === lane) add(e, 'The lane closed');
    else if (e.from === s.agent && reply === s.requestId && (e.act === 'decline' || e.act === 'challenge'))
      add(e, `${s.agent} said no`);
    else if (e.from === s.me && (e.act === 'accept' || e.act === 'decline') && typeof reply === 'string') {
      const ask = byId.get(reply);
      if (ask && metaLane(ask, 'lane_review') === lane)
        add(e, e.act === 'accept' ? 'You accepted it' : 'You sent it back');
    } else if (e.from === s.agent && e.act === 'status_update' && e.ts >= opened && e.body.trim())
      add(e, `${s.agent}: ${e.body.trim()}`);
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

/** `15:12:09`, in the viewer's local time. */
export function timeOfDay(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** Which of the step ids the rail lights: the steps before this one and this one. */
export function stepIndex(id: TourStepId): number {
  return TOUR_STEPS.findIndex((s) => s.id === id);
}

export const TOUR_STEP_COUNT = TOUR_STEPS.length;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** When a lane opened, from its ULID's first ten characters; the resume replay starts there. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return 0;
    t = t * 32 + v;
  }
  return t;
}
