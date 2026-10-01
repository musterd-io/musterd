import { spawn as nodeSpawn } from 'node:child_process';
import { constants } from 'node:os';
import { CliError } from '../errors.js';
import type { LaunchPlan } from './plan.js';

type Sig = 'SIGINT' | 'SIGQUIT' | 'SIGTERM' | 'SIGHUP';

export interface SuperviseDeps {
  spawn?: typeof nodeSpawn;
  /** Signal registration (tests). Defaults to `process`. */
  signals?: { on(sig: Sig, fn: () => void): unknown; off(sig: Sig, fn: () => void): unknown };
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface SuperviseResult {
  code: number;
  durationMs: number;
}

/**
 * Run a harness with the terminal handed over (ADR 491 Decision 3). musterd stays its parent:
 * SIGINT/SIGQUIT are ignored here (the terminal delivers them to the harness too, which decides),
 * SIGTERM/SIGHUP are forwarded, and the harness's exit code comes back — 128 + n for signal n.
 * The environment passes through untouched: identity reaches the harness through the Workspace's
 * MCP registration (ADR 286), never through the launcher.
 */
export function supervise(plan: LaunchPlan, deps: SuperviseDeps = {}): Promise<SuperviseResult> {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const signals = deps.signals ?? process;
  const now = deps.now ?? Date.now;
  const started = now();
  return new Promise((resolve, reject) => {
    const child = spawnFn(plan.bin, plan.args, {
      cwd: plan.cwd,
      env: deps.env ?? process.env,
      stdio: 'inherit',
    });
    const ignore = (): void => {};
    const term = (): void => void child.kill('SIGTERM');
    const hup = (): void => void child.kill('SIGHUP');
    signals.on('SIGINT', ignore);
    signals.on('SIGQUIT', ignore);
    signals.on('SIGTERM', term);
    signals.on('SIGHUP', hup);
    const release = (): void => {
      signals.off('SIGINT', ignore);
      signals.off('SIGQUIT', ignore);
      signals.off('SIGTERM', term);
      signals.off('SIGHUP', hup);
    };
    child.once('error', (err: Error) => {
      release();
      reject(new CliError(`couldn't start ${plan.bin}: ${err.message}`, 1));
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      release();
      const exit = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
      resolve({ code: exit, durationMs: now() - started });
    });
  });
}
