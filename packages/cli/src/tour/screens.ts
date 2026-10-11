import type { TourState } from './machine.js';
import { fill, TOUR_STEPS, type TourStepId } from './script.generated.js';

/**
 * The tour's text, as pure functions: what each step says once its placeholders are filled. The
 * `cmd/tour` frames in docs/design/figma-brief-terminal.md are pinned by screens.test.ts.
 */
export interface TourVars {
  you: string;
  agent: string;
  lane: string;
  /** The model the harness observed, from the roster; '' when unattested. */
  model: string;
}

function stepOf(id: TourStepId) {
  const step = TOUR_STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`unknown tour step: ${id}`);
  return step;
}

export function stepTitle(id: TourStepId): string {
  const index = TOUR_STEPS.findIndex((s) => s.id === id);
  return `Step ${index + 1} of ${TOUR_STEPS.length} · ${stepOf(id).title}`;
}

export function verdictLine(s: TourState, you: string): string {
  if (s.outcome === 'self_closed') return `closed by ${s.agent} itself`;
  if (s.outcome === 'declined') return `declined by ${s.agent}`;
  const accepted = `accepted by ${you}`;
  return s.sentBack > 0 ? `sent back by ${you}, then ${accepted}` : accepted;
}

/**
 * The step's body with placeholders filled. With no observed model, the record line says
 * `model unattested` (as `musterd status` does); on every other step a line about the model drops.
 */
export function stepBody(s: TourState, v: TourVars): string {
  const record = s.step === 'record';
  const lines = stepOf(s.step).body.filter(
    (line) => record || v.model !== '' || !line.includes('{model}'),
  );
  const vars = {
    you: v.you,
    agent: v.agent,
    lane: v.lane,
    model: v.model || 'unattested',
    verdict: verdictLine(s, v.you),
  };
  return lines.map((line) => fill(line, vars)).join('\n');
}

/** The latest hint due at `elapsedMs` on this step, filled; null before the first. */
export function hintFor(id: TourStepId, elapsedMs: number, v: TourVars): string | null {
  const due = stepOf(id).hints.filter((h) => elapsedMs >= h.afterMs);
  const last = due[due.length - 1];
  return last ? fill(last.text, { you: v.you, agent: v.agent, lane: v.lane }) : null;
}
