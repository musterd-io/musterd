import { STATUS_LINE_MAX, StatusLineTextSchema } from '@musterd/protocol';
import { GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd status-line [<words…>] [--clear]` — your own status line (ADR 721): a few words a human
 * sets for themselves, shown on /live, /broadcast and the team panel for an hour. The words are
 * joined, so no quotes are needed. Bare, it prints yours. Self only and humans only: the daemon
 * refuses an agent seat, an observer and a credential acting as another seat.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads.
 */
export const STATUS_LINE_FLAGS = ['clear'] as const;

export async function statusLineCommand(parsed: Parsed): Promise<number> {
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...STATUS_LINE_FLAGS],
    'the flags `musterd status-line` takes are listed by `musterd help status-line`',
  );
  const { team, http, identity } = resolve(parsed.flags);
  const json = Boolean(parsed.flags['json']);

  if (parsed.flags['clear']) {
    const res = await http.clearStatusLine(team);
    if (json) return write(JSON.stringify(res.member));
    return write(success('status line cleared', { next: 'musterd status' }));
  }

  const words = parsed.positionals.join(' ');
  if (words.trim() === '') {
    const roster = await http.roster(team);
    const me = roster.members.find((m) => m.name === identity.name);
    const line = me?.status_line ?? null;
    if (json) return write(JSON.stringify(line));
    if (!line)
      return write(
        theme.meta('no status line — `musterd status-line <words>` sets one for an hour'),
      );
    const mins = Math.max(0, Math.round((line.expires_at - Date.now()) / 60_000));
    return write(`${line.text} ${theme.meta(`· clears in ${mins} min`)}`);
  }

  const text = StatusLineTextSchema.safeParse(words);
  if (!text.success) {
    throw new CliError(
      `${text.error.issues[0]?.message ?? `a status line is at most ${STATUS_LINE_MAX} characters`} (yours is ${[...words.trim()].length})`,
      2,
    );
  }
  const res = await http.setStatusLine(team, text.data);
  if (json) return write(JSON.stringify(res.member));
  return write(
    success(`status line set: ${theme.accent(text.data)} ${theme.meta('· clears in an hour')}`, {
      next: 'musterd status-line --clear',
    }),
  );
}

function write(s: string): number {
  process.stdout.write(s + '\n');
  return 0;
}
