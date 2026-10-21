import { platform as osPlatform } from 'node:os';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { serviceSupported } from '../service/launchd.js';
import { status } from '../service/manage.js';
import { resolveCtx } from './service.js';

/**
 * `musterd reload` — tell the running service-managed daemon to re-resolve its roster roots and
 * reconcile (ADR 058), by sending it SIGHUP. The convenience wrapper around the signal the daemon
 * already handles; use it after `team export` so a newly file-backed team is picked up without a full
 * restart. For a foreground `musterd serve`, signal it directly (`kill -HUP <pid>`).
 */
/**
 * The flags `musterd reload` takes (lane
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
 * The flags `musterd reload` takes (lane
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
export const RELOAD_FLAGS = ['launchctl'] as const;

export async function reloadCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...RELOAD_FLAGS],
    'the flags `musterd reload` takes are listed by `musterd help reload`',
  );
  if (!serviceSupported(osPlatform())) {
    throw new CliError(
      'musterd reload drives a launchd service (macOS) — for a foreground `musterd serve`, send SIGHUP directly: kill -HUP <pid>',
      2,
    );
  }
  const st = status(resolveCtx([]));
  if (!st.loaded || !st.pid) {
    throw new CliError(
      'no running musterd service found — start it with `musterd service start`, or SIGHUP a foreground `musterd serve` directly',
      1,
    );
  }
  try {
    process.kill(st.pid, 'SIGHUP');
  } catch (e) {
    throw new CliError(`couldn't signal the daemon (pid ${st.pid}): ${(e as Error).message}`, 1);
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ok: true, pid: st.pid }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`reloaded the musterd daemon (SIGHUP pid ${st.pid})`, { next: 'musterd status' }) +
      '\n',
  );
  process.stdout.write(theme.meta('re-resolved roster roots and reconciled') + '\n');
  return 0;
}
