import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { signinCommand } from './board.js';

/**
 * `musterd live` (ADR 222) — open the office signed in as yourself, so the asks waiting on you are
 * answerable rather than merely readable.
 *
 * The cold-start sibling of the rail's own sign-in button: same one-shot nonce, same machine-local
 * boundary, different destination. The button is the everyday path once a browser is open; this is
 * for the case where it is not, and for the human who would rather start from a terminal.
 *
 * Why the office needed its own verb at all: `musterd board` shipped in ADR 170 and was redeemed
 * once, on release day, and never again. A surface you must decide to visit does not get visited.
 * The office is the one that stays open, and until now it was the one you could not sign into.
 */
/**
 * The flags `musterd live` takes (lane
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
 * The flags `musterd live` takes (lane
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
export const LIVE_FLAGS = ['no-open', 'print', 'staged'] as const;

export async function liveCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...LIVE_FLAGS],
    'the flags `musterd live` takes are listed by `musterd help live`',
  );
  return signinCommand(parsed, 'live');
}
