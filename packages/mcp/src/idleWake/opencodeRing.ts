import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IDLE_RING_ACK_FILE,
  IDLE_RING_ACK_TIMEOUT_MS,
  IDLE_RING_FILE,
  type IdleRing,
  IdleRingAckSchema,
  OPENCODE_PLUGIN_STAMP_FILE,
  OPENCODE_RING_MIN_GENERATION,
  OPENCODE_STAMP_FRESH_MS,
  OpencodePluginStampSchema,
} from '@musterd/protocol';
import type { InjectAdapter, InjectResult, Probe } from './inject.js';

/**
 * opencode's inject (ADR 558 increment 3). opencode starts a turn only from inside its own process
 * (`client.session.promptAsync` in a plugin; the HTTP route loses most idle prompts, #45564), so the
 * adapter rings the managed plugin (ADR 392, generation ≥ 5) through the workspace's `.musterd/`:
 * it writes `idle-ring.json`, the plugin pushes the line and writes `idle-ring-ack.json`. The
 * plugin's stamp says it is loaded; without a fresh one the session is deaf, by name.
 */
const POLL_MS = 250;

export interface OpencodeRingDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newSeq?: () => string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function opencodeRing(dir: string, deps: OpencodeRingDeps = {}): InjectAdapter {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newSeq = deps.newSeq ?? (() => randomBytes(8).toString('hex'));
  const base = join(dir, '.musterd');

  const probe = (): Probe => {
    const stamp = OpencodePluginStampSchema.safeParse(
      readJson(join(base, OPENCODE_PLUGIN_STAMP_FILE)),
    );
    if (!stamp.success) return { ready: false, reason: 'no-plugin' };
    if (stamp.data.generation < OPENCODE_RING_MIN_GENERATION)
      return { ready: false, reason: 'plugin-stale' };
    if (now() - stamp.data.at > OPENCODE_STAMP_FRESH_MS)
      return { ready: false, reason: 'plugin-gone' };
    return { ready: true };
  };

  const inject = async (line: string): Promise<InjectResult> => {
    const p = probe();
    if (!p.ready) return { ok: false, reason: p.reason };
    const ring: IdleRing = { seq: newSeq(), line, at: now() };
    try {
      const path = join(base, IDLE_RING_FILE);
      // A fresh name opened O_EXCL ('wx'): a planted file or symlink at the tmp path fails the
      // write instead of redirecting it. rename() replaces a link at `path`, never its target.
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(ring), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (err) {
      return { ok: false, reason: `ring:${(err as NodeJS.ErrnoException).code ?? 'error'}` };
    }
    const deadline = ring.at + IDLE_RING_ACK_TIMEOUT_MS;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const ack = IdleRingAckSchema.safeParse(readJson(join(base, IDLE_RING_ACK_FILE)));
      if (ack.success && ack.data.seq === ring.seq)
        return ack.data.ok ? { ok: true } : { ok: false, reason: ack.data.reason ?? 'refused' };
    }
    return { ok: false, reason: 'no-ack' };
  };

  return { harness: 'opencode', probe, inject };
}
