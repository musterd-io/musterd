import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * Force-drop a member's stuck/stale live session so it can rejoin (ADR 017 follow-up). The
 * sanctioned alternative to editing the daemon's DB: newest-wins self-heals a *reconnecting*
 * session, but an orphaned presence that never comes back needs an explicit reclaim.
 */
export async function reclaimCommand(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[0];
  if (!name) throw new CliError('usage: musterd reclaim <member>', 2);
  const { team, http } = resolve(parsed.flags);
  let res: Awaited<ReturnType<typeof http.reclaim>>;
  try {
    res = await http.reclaim(team, name);
  } catch (err) {
    // ADR 055 §2, the no-dead-end rule: every terminal error names a runnable next step. The
    // daemon's "no member X" is accurate and leaves the operator nowhere — the roster is the answer.
    if (err instanceof CliError && err.code === 'not_found')
      throw new CliError(
        `${err.message} — \`musterd status\` lists the roster`,
        err.exitCode,
        err.code,
      );
    throw err;
  }
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`reclaimed ${theme.memberName(res.member, 'agent')}`, { next: 'musterd status' }) +
      '\n',
  );
  process.stdout.write(theme.meta('any live session was dropped; it can rejoin now') + '\n');
  return 0;
}
