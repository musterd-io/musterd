import { CliError } from '../errors.js';
import { resolveAdapter, type HarnessAdapter } from '../onboard/reconcile/fragments.js';
import { chooseHarness, harnessLabel } from './labels.js';
import type { Recent, Seat } from './store.js';

export { chooseHarness };

/** What to run, where (ADR 491 Decision 5). */
export interface LaunchPlan {
  bin: string;
  args: string[];
  cwd: string;
  /** The harness id, or `shell` for a human seat. */
  harness: string;
  /** Extra environment for the harness (ADR 546: `MUSTERD_TOOK_OVER`), layered over the launcher's. */
  env?: NodeJS.ProcessEnv;
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
