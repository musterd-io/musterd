import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasRunnable } from './claudeBin.js';

/**
 * Where `muse` (Meta's Muse Code CLI, ADR 619) installs. The official installer
 * (`curl -fsSL https://dev.meta.ai/install.sh | bash`) defaults to `~/.local/bin/muse`;
 * Homebrew and /usr/local are the other usual homes. The bare name is unambiguous (nothing
 * else on PATH is called `muse`), so it is probed first.
 */
export function museCandidates(home: string = homedir()): string[] {
  return [join(home, '.local', 'bin', 'muse'), '/opt/homebrew/bin/muse', '/usr/local/bin/muse'];
}

/** Resolve a runnable `muse` without a shell. A miss is not cached. */
export async function resolveMuseBin(
  runnable: (cmd: string, args: string[]) => Promise<{ ok: boolean }> = hasRunnable,
  home: string = homedir(),
): Promise<string | null> {
  if ((await runnable('muse', ['--version'])).ok) return 'muse';
  for (const candidate of museCandidates(home)) {
    if (existsSync(candidate) && (await runnable(candidate, ['--version'])).ok) return candidate;
  }
  return null;
}
