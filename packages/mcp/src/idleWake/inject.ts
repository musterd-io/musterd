import { claudeInbox } from './claudeInbox.js';
import { opencodeRing } from './opencodeRing.js';

/**
 * One inject adapter per harness (ADR 558 §6): `probe()` says whether this session can be pushed,
 * `inject(line)` pushes the daemon-composed line. Increments 3/4/6 add opencode, codex and grok
 * here; nothing else in the core changes. Muse stays `no-inject:muse`: Muse 1.4.10 has no
 * outside push (ADR 558 §6, measured 2026-10-16). An `inject` that finds a turn running answers
 * `{ ok: false, reason: 'busy' }`: the core holds the act and looks again, and the session stays
 * hearing.
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
  const name = harness ?? 'unknown';
  return {
    harness: name,
    probe: () => ({ ready: false, reason: `no-inject:${name}` }),
    inject: () => Promise.resolve({ ok: false, reason: `no-inject:${name}` }),
  };
}
