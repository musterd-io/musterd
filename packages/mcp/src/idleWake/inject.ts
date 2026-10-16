import { claudeInbox } from './claudeInbox.js';
import { codexQueue } from './codexQueue.js';
import { grokLeader } from './grokLeader.js';
import { opencodeRing } from './opencodeRing.js';

/**
 * One inject adapter per harness (ADR 558 §6): `probe()` says whether this session can be pushed,
 * `inject(line)` pushes the daemon-composed line. Codex is `codex queue --thread` when SessionStart
 * stored a live thread id and the CLI is at least 0.149.0 (measured 2026-10-16 on 0.162.1).
 * Muse stays `no-inject:muse`: Muse 1.4.10 has no outside push (ADR 558 §6, measured 2026-10-16).
 * A default Grok TUI has no leader socket and probes `no-leader-socket` (1.0.62, 2026-10-16). An
 * `inject` that finds a turn running answers `{ ok: false, reason: 'busy' }`: the core holds the act
 * and looks again, and the session stays hearing.
 */
export type Probe = { ready: true } | { ready: false; reason: string };
export type InjectResult = { ok: true } | { ok: false; reason: string };
export interface InjectAdapter {
  readonly harness: string;
  probe(): Probe;
  inject(line: string): Promise<InjectResult>;
}

export function injectAdapterFor(
  harness: string | null,
  env: NodeJS.ProcessEnv = process.env,
  dir: string = process.cwd(),
): InjectAdapter {
  if (harness === 'claude-code') return claudeInbox(env);
  if (harness === 'opencode') return opencodeRing(dir);
  if (harness === 'grok') return grokLeader(env, dir);
  if (harness === 'codex') return codexQueue(dir);
  const name = harness ?? 'unknown';
  return {
    harness: name,
    probe: () => ({ ready: false, reason: `no-inject:${name}` }),
    inject: () => Promise.resolve({ ok: false, reason: `no-inject:${name}` }),
  };
}
