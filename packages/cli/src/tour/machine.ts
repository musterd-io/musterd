import type { Envelope } from '@musterd/protocol';
import { TOUR_STEPS, type TourStepId } from './script.generated.js';

/**
 * The tour's step machine (spec 2026-10-10-first-run-tour-design): pure, so every failure case is a
 * unit test. Only an act about THIS tour's lane can move it — a real team carries a steady stream of
 * unrelated acts, and any of them advancing the tour would teach the wrong thing.
 */
export type TourOutcome = 'accepted' | 'self_closed' | 'declined';

export interface TourState {
  step: TourStepId;
  me: string;
  agent: string;
  laneId?: string;
  /** The request_help act the tour sent the agent; a decline counts only if it replies to this. */
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

export function initialState(me: string, agent: string): TourState {
  return { step: 'what', me, agent, sentBack: 0 };
}

export function stepAfter(id: TourStepId): TourStepId | null {
  const i = TOUR_STEPS.findIndex((s) => s.id === id);
  return TOUR_STEPS[i + 1]?.id ?? null;
}

function waitOf(id: TourStepId): string | undefined {
  return TOUR_STEPS.find((s) => s.id === id)?.wait;
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
    if (!fromAgent) return s;
    if (metaLane(env, 'lane_claim') === s.laneId) return { ...s, step: 'hands_back' };
    const declines = env.act === 'decline' || env.act === 'challenge';
    if (declines && metaOf(env)['in_reply_to'] === s.requestId) {
      return { ...s, outcome: 'declined', declineReason: env.body };
    }
    return s;
  }

  if (s.step === 'hands_back' || s.step === 'judge') {
    if (fromAgent && metaLane(env, 'lane_resolve') === s.laneId) {
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

/** Returns `s` itself (same reference) when the event does not apply, so callers can detect a no-op. */
export function advance(s: TourState, e: TourEvent): TourState {
  switch (e.type) {
    case 'continue': {
      const w = waitOf(s.step);
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
