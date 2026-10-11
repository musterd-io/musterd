import { claudeInbox } from './claudeInbox.js';

/**
 * One inject adapter per harness (ADR 558 §6): `probe()` says whether this session can be pushed,
 * `inject(line)` pushes the daemon-composed line. Increments 3/4/6 add opencode, codex and grok
 * here; nothing else in the core changes.
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
): InjectAdapter {
  if (harness === 'claude-code') return claudeInbox(env);
  const name = harness ?? 'unknown';
  return {
    harness: name,
    probe: () => ({ ready: false, reason: `no-inject:${name}` }),
    inject: () => Promise.resolve({ ok: false, reason: `no-inject:${name}` }),
  };
}
