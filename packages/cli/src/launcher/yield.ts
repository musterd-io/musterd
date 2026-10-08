import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINDING_DIR,
  WAKE_YIELD_FILE,
  WakeYieldFileSchema,
  type WakeYieldFile,
} from '@musterd/protocol';

/**
 * The yield marker (ADR 546): a person asks the wake holding `lease_id` in this folder to stop.
 * Removed first and created exclusively (`wx`), so a symlink planted at the marker's path is
 * replaced, never written through to wherever it points.
 */
export function writeYieldFile(workspace: string, y: WakeYieldFile): void {
  mkdirSync(join(workspace, BINDING_DIR), { recursive: true });
  const path = join(workspace, BINDING_DIR, WAKE_YIELD_FILE);
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(y) + '\n', { mode: 0o600, flag: 'wx' });
}

export function readYieldFile(workspace: string): WakeYieldFile | null {
  try {
    const parsed = WakeYieldFileSchema.safeParse(
      JSON.parse(readFileSync(join(workspace, BINDING_DIR, WAKE_YIELD_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The PreToolUse deny for a wake a person has taken over, or null. Keyed on the session's own lease
 * (`MUSTERD_WAKE_LEASE`, which the host sets and hooks inherit): a person's session carries none, and
 * a later wake carries a different one, so a leftover marker can stop nothing else.
 */
export function yieldDenyReason(workspace: string, env: NodeJS.ProcessEnv): string | null {
  const lease = env['MUSTERD_WAKE_LEASE']?.trim();
  if (!lease) return null;
  const y = readYieldFile(workspace);
  if (!y || y.lease_id !== lease) return null;
  return `${y.by} has taken over this seat — end your turn now; do not retry this or any other tool.`;
}

export interface StopDeps {
  alive?: (pid: number) => boolean;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  killGraceMs?: number;
}

const POLL_MS = 250;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the wake to stop at its next tool call; past the grace, stop its process group the way the
 * host's own watchdog does (detached ⇒ the harness leads its group). ADR 546.
 */
export async function stopWake(
  wake: { workspace: string; lease_id: string; pid: number },
  by: string,
  deps: StopDeps = {},
): Promise<'yielded' | 'killed'> {
  const alive = deps.alive ?? pidAlive;
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  writeYieldFile(wake.workspace, { lease_id: wake.lease_id, by, at: now() });
  const waitGone = async (ms: number): Promise<boolean> => {
    const deadline = now() + ms;
    while (now() < deadline) {
      if (!alive(wake.pid)) return true;
      await sleep(POLL_MS);
    }
    return !alive(wake.pid);
  };
  if (await waitGone(deps.graceMs ?? 10_000)) return 'yielded';
  try {
    kill(-wake.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  if (await waitGone(deps.killGraceMs ?? 5_000)) return 'killed';
  try {
    kill(-wake.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  return 'killed';
}
