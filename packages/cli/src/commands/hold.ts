import {
  describeHoldLine,
  type Hold,
  type HoldEffect,
  HoldEffectSchema,
  isHoldActive,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolveHoldUntil } from '../service/hold.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd hold set <autorefresh_paused|merges_paused|notice> --for <2h|90m> | --until <HH:MM> --reason "<why>"\n' +
  '       musterd hold lift <id>\n' +
  '       musterd hold list [--all]';

/**
 * ADR 516 — Team holds. `musterd hold set` is the one place a Team says "this is paused", with an
 * author and an end; every seat reads it from `team_next` / `musterd status` and it clears itself.
 * Who may set or lift is the daemon's decision (a human admin) — an agent running this is refused
 * there, not here. `list` is anyone's.
 */
export async function holdCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;

  if (sub === 'set') {
    const effect = HoldEffectSchema.safeParse(parsed.positionals[1]);
    const reason = flagStr(parsed.flags, 'reason')?.trim();
    if (!effect.success || !reason) throw new CliError(USAGE, 2);
    let until: number;
    try {
      until = resolveHoldUntil({
        ...(flagStr(parsed.flags, 'until') !== undefined
          ? { until: flagStr(parsed.flags, 'until')! }
          : {}),
        ...(flagStr(parsed.flags, 'for') !== undefined
          ? { for: flagStr(parsed.flags, 'for')! }
          : {}),
        now: new Date(),
      });
    } catch (err) {
      throw new CliError(`${(err as Error).message}\n${USAGE}`, 2);
    }
    const hold = await http.setHold(team, { effect: effect.data, reason, until });
    if (json) return printJson(hold);
    process.stdout.write(
      success(describeHoldLine(hold, Date.now()), { next: `musterd hold lift ${hold.id}` }) + '\n',
    );
    process.stdout.write(theme.meta(enforcementNote(hold.effect)) + '\n');
    return 0;
  }

  if (sub === 'lift') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    let hold: Hold;
    try {
      hold = await http.liftHold(team, id);
    } catch (err) {
      if (err instanceof CliError && err.code === 'not_found')
        throw new CliError(
          `${err.message} — \`musterd hold list\` shows what is in force`,
          err.exitCode,
          err.code,
        );
      throw err;
    }
    if (json) return printJson(hold);
    process.stdout.write(
      success(`lifted: ${hold.effect.replaceAll('_', ' ')} — ${hold.reason}`, {
        next: 'musterd hold list',
      }) + '\n',
    );
    return 0;
  }

  if (sub === 'list' || sub === undefined) {
    const holds = await http.listHolds(team, parsed.flags['all'] === true);
    if (json) return printJson(holds);
    process.stdout.write(renderHolds(holds, Date.now()) + '\n');
    return 0;
  }

  throw new CliError(USAGE, 2);
}

/** What the hold actually does — said every time, so nobody reads more into it than it holds. */
export function enforcementNote(effect: HoldEffect): string {
  switch (effect) {
    case 'autorefresh_paused':
      return 'every machine’s autorefresh stands down until it ends; a manual `musterd service refresh` still works';
    case 'merges_paused':
      return 'announced to every seat; gate enforcement of merges is not built yet (ADR 516 increment 2)';
    case 'notice':
      return 'a notice — shown to every seat, enforced nowhere';
  }
}

/** One line per hold; ended ones (from `--all`) are dimmed with how they ended. */
export function renderHolds(holds: Hold[], now: number): string {
  if (holds.length === 0) return theme.meta('no holds in force');
  return holds
    .map((h) => {
      if (isHoldActive(h, now))
        return `${theme.warn('⏸')} ${describeHoldLine(h, now)}  ${theme.meta(h.id)}`;
      const how = h.lifted_at !== null ? `lifted by ${h.lifted_by}` : 'ended';
      return theme.meta(
        `  ${h.effect.replaceAll('_', ' ')} by ${h.created_by} — ${how}: ${h.reason}  ${h.id}`,
      );
    })
    .join('\n');
}

function printJson(v: unknown): number {
  process.stdout.write(JSON.stringify(v) + '\n');
  return 0;
}
