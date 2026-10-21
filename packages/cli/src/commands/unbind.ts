import { autoClaims } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, removeBinding } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';

/**
 * `musterd unbind` — stop occupying this folder's seat without removing it from the team (ADR 058).
 * Clears the daemon-side held state (`bound_at`) + presence so the seat reads *declared* and is freely
 * re-claimable, then deletes this folder's `binding.json`. The committed `seats/<name>.toml` is
 * untouched. This is the clean separation the file model finally allows: `unbind` = "I leave this
 * seat", `team remove` = "this seat should no longer exist".
 */
/**
 * The flags `musterd unbind` takes (lane
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
/**
 * The flags `musterd unbind` takes (lane
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
export const UNBIND_FLAGS = [] as const;

export async function unbindCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...UNBIND_FLAGS],
    'the flags `musterd unbind` takes are listed by `musterd help unbind`',
  );
  const binding = findBinding();
  if (!binding || !autoClaims(binding)) {
    throw new CliError('this folder holds no seat — nothing to unbind', 2);
  }
  const http = new HttpClient({
    server: binding.server,
    ...(binding.agent_key ? { key: binding.agent_key } : {}),
  });
  const res = await http.unbind(binding.team);
  removeBinding(process.cwd());

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: binding.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`unbound ${theme.memberName(res.member, 'agent')} from this folder`, {
      next: 'musterd claim',
    }) + '\n',
  );
  process.stdout.write(
    theme.meta(
      `the seat stays on ${binding.team}, free to re-claim — to remove it entirely: musterd team remove ${res.member}`,
    ) + '\n',
  );
  return 0;
}
