import { wrapText } from '../render/ui.js';
import type { TourState } from './machine.js';
import { fill, TOUR_STEPS, type TourStepId } from './script.generated.js';

/**
 * The tour's text, as pure functions: what each step says once its placeholders are filled. The
 * `cmd/tour` frames in docs/design/figma-brief-terminal.md are pinned by screens.test.ts.
 */
export type TourVars = {
  you: string;
  agent: string;
  lane: string;
  /** The model the harness observed, from the roster; '' when unattested. */
  model: string;
};

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

/**
 * Step 2's roster: you, then the agent taking the tour. The body's own line carries the model. A
 * large team collapses to a count, so the step stays one screen.
 */
export function rosterLines(
  roster: readonly { name: string }[],
  you: string,
  agent: string,
): string[] {
  const width = Math.max(you.length, agent.length);
  const lines = [`  ${you.padEnd(width)}  human, you`, `  ${agent.padEnd(width)}  agent`];
  const rest = roster.filter((m) => m.name !== you && m.name !== agent).length;
  if (rest > 0) lines.push(`  and ${rest} more member${rest === 1 ? '' : 's'}`);
  return lines;
}

/**
 * Fit a step to the terminal. A line that fits keeps its spacing (the `next` step aligns columns);
 * a longer one wraps at word boundaries and keeps its indent, so a step never draws wider than the
 * screen and breaks its own box.
 */
export function wrapBody(text: string, width: number): string {
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const indent = /^ */.exec(line)![0];
      return wrapText(line, Math.max(1, width - indent.length)).map((l) => indent + l);
    })
    .join('\n');
}

/**
 * What an agent wrote (the lane summary, a decline reason), made safe to print: every control
 * character except newline and tab is dropped, so an escape sequence cannot clear the screen, retitle
 * the terminal or forge the tour's own lines.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
