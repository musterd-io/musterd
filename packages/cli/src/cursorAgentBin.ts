import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasRunnable } from './claudeBin.js';

/**
 * Where `cursor-agent` installs. Never the bare `agent` name: with Grok installed, `agent` on PATH is
 * Grok's binary (measured on the dogfood machine 2026-10-01), so probing it would launch the wrong
 * harness.
 */
export function cursorAgentCandidates(home: string = homedir()): string[] {
  return [
    join(home, '.local', 'bin', 'cursor-agent'),
    '/opt/homebrew/bin/cursor-agent',
    '/usr/local/bin/cursor-agent',
  ];
}

/** Resolve a runnable `cursor-agent` without a shell. A miss is not cached. */
export async function resolveCursorAgentBin(
  runnable: (cmd: string, args: string[]) => Promise<{ ok: boolean }> = hasRunnable,
  home: string = homedir(),
): Promise<string | null> {
  if ((await runnable('cursor-agent', ['--version'])).ok) return 'cursor-agent';
  for (const candidate of cursorAgentCandidates(home)) {
    if (existsSync(candidate) && (await runnable(candidate, ['--version'])).ok) return candidate;
  }
  return null;
}
