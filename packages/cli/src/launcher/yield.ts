import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINDING_DIR,
  WAKE_LEASE_FILE,
  WAKE_YIELD_FILE,
  WakeLeaseFileSchema,
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

/**
 * True while the wake-lease file in `workspace` still names this lease AND this pid. The host clears
 * it when the run settles, so a missing or different file means the wake is over and its pid may
 * already belong to something else — the one fact that keeps `stopWake` from signalling a stranger.
 */
export function leaseStillHeld(workspace: string, lease_id: string, pid: number): boolean {
  try {
    const parsed = WakeLeaseFileSchema.safeParse(
      JSON.parse(readFileSync(join(workspace, BINDING_DIR, WAKE_LEASE_FILE), 'utf8')),
    );
    return parsed.success && parsed.data.lease_id === lease_id && parsed.data.spawner_pid === pid;
  } catch {
    return false;
  }
}

export interface StopDeps {
  /** Injectable re-check before each signal (default: {@link leaseStillHeld}). */
  holds?: (wake: { workspace: string; lease_id: string; pid: number }) => boolean;
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
  wake: { workspace: string; lease_id: string; pid: number; in_process?: boolean },
  by: string,
  deps: StopDeps = {},
): Promise<'yielded' | 'killed' | 'stuck'> {
  const alive = deps.alive ?? pidAlive;
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals) => void process.kill(p, s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const holds = deps.holds ?? ((w) => leaseStillHeld(w.workspace, w.lease_id, w.pid));
  writeYieldFile(wake.workspace, { lease_id: wake.lease_id, by, at: now() });
  if (wake.in_process) {
    // The wake is a loop inside the host: its pid is the host's, so there is nothing to signal. It
    // reads the marker itself and ends at a tool boundary; the lease file clearing is the answer.
    const deadline = now() + (deps.graceMs ?? 10_000);
    while (holds(wake)) {
      if (now() >= deadline) return 'stuck';
      await sleep(POLL_MS);
    }
    return 'yielded';
  }
  const waitGone = async (ms: number): Promise<boolean> => {
    const deadline = now() + ms;
    while (now() < deadline) {
      if (!alive(wake.pid)) return true;
      await sleep(POLL_MS);
    }
    return !alive(wake.pid);
  };
  if (await waitGone(deps.graceMs ?? 10_000)) return 'yielded';
  // The pid was checked a moment ago, not now: if the lease no longer names it, the wake settled
  // on its own and the pid may be someone else's. Never signal on a guess.
  if (!holds(wake)) return 'yielded';
  try {
    kill(-wake.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  if (await waitGone(deps.killGraceMs ?? 5_000)) return 'killed';
  if (!holds(wake)) return 'killed';
  try {
    kill(-wake.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  return 'killed';
}
