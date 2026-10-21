import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * ADR 501 — halt as revocation. `musterd halt <seat> --reason "<text>"` withdraws an agent seat's
 * authority at its next boundary: the daemon revokes its session leases, evicts its presences,
 * refuses its re-claim and its next gated tool call with "halted by <human>: <reason>", and hands
 * it to no host until a human lifts it with `musterd resume <seat>`. Who may halt is decided by
 * the daemon (human-only; admin any agent, a non-admin only agents they sponsor) — this command
 * only carries the words. The honest limit is printed every time: nothing is killed, and a seat
 * mid-tool is reached when that tool returns.
 */
/**
 * The flags `musterd halt`/`resume` takes (lane
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
export const HALT_FLAGS = ['already', 'codex', 'opencode', 'reason'] as const;

export async function haltCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...HALT_FLAGS],
    'the flags `musterd halt` takes are listed by `musterd help halt`',
  );
  const name = parsed.positionals[0];
  const reason = parsed.flags['reason'];
  if (!name || typeof reason !== 'string' || !reason.trim())
    throw new CliError('usage: musterd halt <seat> --reason "<why>"', 2);
  const { team, http } = resolve(parsed.flags);
  let res: Awaited<ReturnType<typeof http.haltMember>>;
  try {
    res = await http.haltMember(team, name, reason.trim());
  } catch (err) {
    throw withNextStep(err, name);
  }
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`halted ${theme.memberName(res.member, 'agent')} — ${res.halted.reason}`, {
      next: `musterd resume ${res.member}`,
    }) + '\n',
  );
  process.stdout.write(
    theme.meta(
      `effective at the seat's next tool boundary or musterd call — nothing is killed; ` +
        `${res.presences_evicted} live session${res.presences_evicted === 1 ? '' : 's'} evicted`,
    ) + '\n',
  );
  const ungated = ungatedSurfaceNotice(res.evicted_surfaces);
  if (ungated) process.stdout.write(theme.warn(`⚠ ${ungated}`) + '\n');
  return 0;
}

/**
 * Harnesses that run local tools but wire no PreToolUse hook, so the ADR 501 Decision 4 deny
 * cannot reach them: Codex (ADR 442, "not gateable") and OpenCode. Claude Code, Cursor and Grok
 * wire the gate; `cli` and `web` run no local tools at all. Measured 2026-10-03 on big-body
 * (docs/wiki/halt-as-revocation.md): a halted Codex seat kept calling local tools until its next
 * musterd call, which is the one thing a halt stops on every harness.
 */
const UNGATED_HARNESSES = new Set(['codex', 'opencode']);

/** Lane 01M41Q39C9: the one extra line a halt prints when an evicted session cannot be gated. */
export function ungatedSurfaceNotice(surfaces: string[] | undefined): string | null {
  const ungated = [...new Set((surfaces ?? []).filter((s) => UNGATED_HARNESSES.has(s)))];
  if (ungated.length === 0) return null;
  return `local tools are not gated on ${ungated.join(', ')} — the seat stops at its next musterd call`;
}

/** `musterd resume <seat>` — lift a halt. Any human who could have halted the seat may resume it. */
export async function resumeCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...HALT_FLAGS],
    'the flags `musterd resume` takes are listed by `musterd help resume`',
  );
  const name = parsed.positionals[0];
  if (!name) throw new CliError('usage: musterd resume <seat>', 2);
  const { team, http } = resolve(parsed.flags);
  let res: Awaited<ReturnType<typeof http.resumeMember>>;
  try {
    res = await http.resumeMember(team, name);
  } catch (err) {
    throw withNextStep(err, name);
  }
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  const was = res.was ? ` — was halted by ${res.was.by}: ${res.was.reason}` : '';
  process.stdout.write(
    success(`resumed ${theme.memberName(res.member, 'agent')}${was}`, {
      next: 'musterd status',
    }) + '\n',
  );
  process.stdout.write(
    theme.meta('its next claim mints a fresh lease; residency wakes it again') + '\n',
  );
  return 0;
}

/** ADR 055 §2 — every terminal error names a runnable next step. */
function withNextStep(err: unknown, seat: string): unknown {
  if (!(err instanceof CliError)) return err;
  if (err.code === 'not_found')
    return new CliError(
      `${err.message} — \`musterd status\` lists the roster`,
      err.exitCode,
      err.code,
    );
  if (err.code === 'conflict' && err.message.includes('already'))
    return new CliError(
      `${err.message} — \`musterd resume ${seat}\` lifts it`,
      err.exitCode,
      err.code,
    );
  if (err.code === 'conflict')
    return new CliError(
      `${err.message} — \`musterd halt ${seat} --reason …\` halts it`,
      err.exitCode,
      err.code,
    );
  return err;
}
