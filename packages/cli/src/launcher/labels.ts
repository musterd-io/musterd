import type { Seat } from './store.js';

/** Short harness labels for rows and receipts: the word a person types to start it (ADR 491). */
const LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  cursor: 'cursor',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
  musterd: 'musterd',
  shell: 'shell',
  human: 'human',
};

export function harnessLabel(id: string): string {
  return LABELS[id] ?? id;
}

/**
 * The harnesses with a terminal entry, in ADR 281 registry order. Kept here, not read from the
 * registry, because the picker paints before any adapter loads; `interactive.test.ts` holds the
 * two in step.
 */
export const LAUNCHABLE_HARNESSES: readonly string[] = [
  'claude-code',
  'cursor',
  'codex',
  'opencode',
  'grok',
];

/** Asked for > the harness used last (if still desired) > first desired > last session > claude-code. */
export function chooseHarness(
  seat: Seat,
  requested: string | null,
  recentHarness: string | null,
): string {
  if (requested) return requested;
  const launchable = seat.harnesses.filter((h) => h !== 'musterd');
  if (recentHarness && (launchable.length === 0 || launchable.includes(recentHarness)))
    return recentHarness;
  return launchable[0] ?? seat.last_session?.harness ?? 'claude-code';
}
