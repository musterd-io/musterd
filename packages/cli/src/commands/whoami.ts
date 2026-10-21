import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolveRead } from './helpers.js';

/**
 * `musterd whoami` (ADR 067) — print the identity this folder resolves to right now, and where it
 * came from. The first thing a fresh agent reaches for to confirm which seat it's acting as before it
 * sends; without it, the only way to check was to read a binding file by hand. Read-only and
 * identity-optional (ADR 036): an unbound folder is a valid answer, not an error — it prints how to
 * claim a seat instead. The `source` makes the precedence legible (env > binding). There is no
 * ambient case any more: a folder acts only as the member it is bound to (ADR 442).
 */
/**
 * Ask the daemon once whether the credential this folder holds is still honoured. A seat whose
 * credential the team revoked used to read "alfie on revive (cli · binding)" — healthy-looking and
 * unable to do anything (alfie, 2026-10-07, lane 01M4E4MP4M). Best-effort and read-only: an offline
 * daemon, a timeout, or a dead session lease (a different fault, with its own message) all return
 * null — only the daemon saying "that credential is not good" is reported.
 */
async function credentialProblem(
  http: { interruptCheck(team: string): Promise<unknown> },
  team: string,
): Promise<string | null> {
  try {
    await http.interruptCheck(team);
    return null;
  } catch (err) {
    if (!(err instanceof CliError)) return null;
    if (err.code !== 'unauthorized' && err.code !== 'forbidden') return null;
    if (/agent session lease/i.test(err.message)) return null;
    // A folder holding only a bootstrap key that has not claimed yet — a freshly provisioned seat —
    // is told to claim; that is a next step, not a rejection. A revoked or expired key is named as
    // such by the daemon (store/members.ts) and falls through to be reported.
    if (/only claims a seat/i.test(err.message)) return null;
    return err.message;
  }
}

/**
 * The flags `musterd whoami` takes (lane
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
export const WHOAMI_FLAGS = [] as const;

export async function whoamiCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...WHOAMI_FLAGS],
    'the flags `musterd whoami` takes are listed by `musterd help whoami`',
  );
  const { team, identity, identitySource, explicit, http } = resolveRead(parsed.flags, {
    claimSeatPerRequest: true,
  });
  const problem = identity ? await credentialProblem(http, team) : null;

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        team,
        member: identity?.name ?? null,
        surface: identity?.surface ?? null,
        source: identitySource ?? null,
        explicit,
        ...(identity
          ? { credential: problem === null ? { ok: true } : { ok: false, problem } }
          : {}),
      }) + '\n',
    );
    return 0;
  }

  if (!identity) {
    process.stdout.write(
      `${theme.meta('not bound')} on team ${theme.accent(team)} — this folder acts as nobody; ` +
        `claim a seat: ${theme.accent('musterd claim <name>')}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${theme.accent(identity.name)} on ${theme.accent(team)} ` +
      theme.meta(`(${identity.surface} · ${identitySource})`) +
      '\n',
  );
  if (problem !== null)
    process.stdout.write(`${theme.warn(`⚠ credential rejected: ${problem}`)}\n`);
  return 0;
}
