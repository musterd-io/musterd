import { CliError } from '../errors.js';
import { resolveAdapter, type HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { harnessLabel } from './labels.js';
import type { Recent, Seat } from './store.js';

/** What to run, where (ADR 491 Decision 5). */
export interface LaunchPlan {
  bin: string;
  args: string[];
  cwd: string;
  /** The harness id, or `shell` for a human seat. */
  harness: string;
}

export interface PlanInput {
  seat: Seat;
  mode: 'fresh' | 'resume';
  /** `--harness` or the picker's tab choice; null → {@link chooseHarness}. */
  harness: string | null;
  /** The session `binding.json` records, read at launch time — never from the snapshot. */
  session: { harness: string; id: string } | null;
  recent: Recent | null;
  registry: HarnessAdapter[];
  env: NodeJS.ProcessEnv;
}

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

export async function planLaunch(input: PlanInput): Promise<LaunchPlan> {
  const { seat } = input;
  if (seat.kind === 'human') {
    return {
      bin: input.env['SHELL'] || '/bin/zsh',
      args: ['-l'],
      cwd: seat.path,
      harness: 'shell',
    };
  }
  const id = chooseHarness(seat, input.harness, input.recent?.harness ?? null);
  const adapter = resolveAdapter(id, input.registry);
  if (!adapter) {
    throw new CliError(
      `unknown harness "${id}" — one of: ${input.registry.map((a) => a.id).join(', ')}`,
      2,
    );
  }
  if (!adapter.interactive)
    throw new CliError(`${id} has no terminal entry — it runs under \`musterd host\``, 1);
  const bin = await adapter.interactive.resolveBin();
  if (!bin)
    throw new CliError(
      `${harnessLabel(id)} is not installed (not on PATH or the usual install locations)`,
      1,
    );
  const sessionId = input.session?.harness === id ? input.session.id : undefined;
  const args =
    input.mode === 'resume' ? adapter.interactive.resume(sessionId) : adapter.interactive.fresh();
  return { bin, args, cwd: seat.path, harness: id };
}
