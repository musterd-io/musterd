import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IdleWakeState, IdleWakeStateSchema } from '@musterd/protocol';

/**
 * `.musterd/idle-wake.json` (ADR 558) — the one file the turn hooks and the MCP adapter share:
 * when the human last prompted, when the last turn ended, and this workspace's session switch.
 * Never a secret. Fail-open on read: an unreadable file is "no evidence", never an error.
 */
export const IDLE_WAKE_FILE = 'idle-wake.json';

export function readIdleWakeState(dir: string): IdleWakeState {
  try {
    const parsed = IdleWakeStateSchema.safeParse(
      JSON.parse(readFileSync(join(dir, '.musterd', IDLE_WAKE_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Merge a patch. A new `session_id` drops the previous session's markers; the switch survives.
 *  Written to a temp file and renamed, so the adapter never reads half a file. */
export function writeIdleWakeState(dir: string, patch: Partial<IdleWakeState>): void {
  const prev = readIdleWakeState(dir);
  const base: IdleWakeState =
    patch.session_id !== undefined && patch.session_id !== prev.session_id
      ? prev.switch
        ? { switch: prev.switch }
        : {}
      : prev;
  const next = { ...base, ...patch };
  const path = join(dir, '.musterd', IDLE_WAKE_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, path);
}
