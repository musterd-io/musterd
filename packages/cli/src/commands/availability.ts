import { AvailabilityStatusSchema } from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd availability <available|away|dnd> [--until <iso>]` — set your own availability axis
 * (SPEC A.6 Axis 2; ADR 044). Explicit and self-only: never inferred, never set on your behalf.
 * `away --until <iso>` is the `away_until` encoding the roster renders as `off until <ts>`. The
 * notify loop reads this back to tier deliveries (away holds all but `urgent`; dnd passes directed +
 * `urgent`). This is the localhost down-payment; the governed superset is the v0.3 seam.
 */
/**
 * The flags `musterd availability` takes (lane
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
export const AVAILABILITY_FLAGS = ['until'] as const;

export async function availabilityCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...AVAILABILITY_FLAGS],
    'the flags `musterd availability` takes are listed by `musterd help availability`',
  );
  const { team, http } = resolve(parsed.flags);
  const raw = parsed.positionals[0];
  const status = AvailabilityStatusSchema.safeParse(raw);
  if (!status.success) {
    throw new CliError('usage: musterd availability <available|away|dnd> [--until <iso>]', 2);
  }

  const untilStr = flagStr(parsed.flags, 'until');
  let until: number | undefined;
  if (untilStr) {
    if (status.data !== 'away') {
      throw new CliError('--until only applies to `away` (the away_until encoding)', 2);
    }
    const parsedTs = Date.parse(untilStr);
    if (Number.isNaN(parsedTs)) throw new CliError(`--until is not a valid date: ${untilStr}`, 2);
    until = parsedTs;
  }

  const res = await http.setAvailability(team, {
    status: status.data,
    ...(until ? { until } : {}),
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.member) + '\n');
    return 0;
  }
  const tail = until ? theme.meta(` until ${new Date(until).toISOString()}`) : '';
  process.stdout.write(
    success(`availability set to ${theme.accent(status.data)}${tail}`, {
      next: 'musterd status',
    }) + '\n',
  );
  return 0;
}
