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
  return last ? fill(last.text, { you: v.you, agent: v.agent, lane: v.lane }) : null;
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
export type TourEntry = { kind: 'none' } | { kind: 'take' } | { kind: 'resume'; lane: Lane };

export function tourEntry(
  lanes: readonly Lane[] | null,
  roster: readonly MemberSummary[],
  you: string,
): TourEntry {
  // The verdict must come from a person (spec §2); a board not read yet offers nothing, rather than
  // a `Take the tour` that a second later turns into `Resume`.
  if (!lanes || roster.find((m) => m.name === you)?.kind !== 'human') return { kind: 'none' };
  const lane = tourLaneOf(lanes, you);
  if (lane) return isOpenTourLane(lane) ? { kind: 'resume', lane } : { kind: 'none' };
  return agentsOf(roster, you).length > 0 ? { kind: 'take' } : { kind: 'none' };
}

export function agentsOf(roster: readonly MemberSummary[], you: string): string[] {
  return roster.filter((m) => m.kind === 'agent' && m.name !== you).map((m) => m.name);
}

/** The agent's attested model, from its first presence; '' when unknown (spec §1). */
export function modelOf(roster: readonly MemberSummary[], name: string): string {
  const model = roster.find((m) => m.name === name)?.presences?.[0]?.model?.trim() ?? '';
  return model === 'unknown' ? '' : model;
}

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
