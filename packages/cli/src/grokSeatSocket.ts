import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { machineConfigRoot } from './machinePaths.js';

/**
 * Per-seat Grok leader socket (ADR 742). The filename function is duplicated in
 * `packages/mcp/src/idleWake/grokLeader.ts`. Both lock sha256("/seats/dreamy").
 * The name is not under `~/.grok/` and is not `leader-*`, so `grok leader kill`
 * does not discover it.
 */
export function grokSeatSocketFile(resolvedDir: string): string {
  return createHash('sha256').update(resolvedDir).digest('hex').slice(0, 32) + '.sock';
}

export function resolveSeatDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** `~/.musterd/grok-sockets/<hash>.sock`, moved with `MUSTERD_CONFIG` (ADR 190). */
export function grokSeatLeaderSocket(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(machineConfigRoot(env), 'grok-sockets', grokSeatSocketFile(resolveSeatDir(dir)));
}

/** Create the socket directory (0700) and return the socket path. Does not bind it. */
export function ensureGrokSeatLeaderDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const socket = grokSeatLeaderSocket(dir, env);
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  return socket;
}
