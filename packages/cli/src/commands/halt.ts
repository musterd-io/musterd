import type { Parsed } from '../args.js';
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
export async function haltCommand(parsed: Parsed): Promise<number> {
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
  return 0;
}

/** `musterd resume <seat>` — lift a halt. Any human who could have halted the seat may resume it. */
export async function resumeCommand(parsed: Parsed): Promise<number> {
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
