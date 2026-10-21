import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * Force-drop a member's stuck/stale live session so it can rejoin (ADR 017 follow-up). The
 * sanctioned alternative to editing the daemon's DB: newest-wins self-heals a *reconnecting*
 * session, but an orphaned presence that never comes back needs an explicit reclaim.
 */
/**
 * The flags `musterd reclaim` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const RECLAIM_FLAGS = [] as const;

export async function reclaimCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...RECLAIM_FLAGS],
    'the flags `musterd reclaim` takes are listed by `musterd help reclaim`',
  );
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
