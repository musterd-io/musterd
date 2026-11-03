import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { success } from '../render/ui.js';
import { resolve, sendOrEcho } from './helpers.js';

/**
 * `musterd shift start <seat>` / `musterd shift stop <seat>` (ADR 792): the same quick action `/live`
 * and the phone send — a person's `steer` with `meta.quick_action` — so Start puts the seat on shift
 * and Stop takes it off, with the daemon composing what the seat reads. Under `shift`, not as bare
 * `musterd start|stop`, because `musterd service start|stop` is the daemon.
 */
export const SHIFT_FLAGS = ['--help', '-c'] as const;

const USAGE = 'usage: musterd shift start <seat> | musterd shift stop <seat>';

export async function shiftCommand(parsed: Parsed): Promise<number> {
  rejectUnknownFlags(parsed.flags, [...GLOBAL_FLAGS, ...SHIFT_FLAGS], USAGE);
  const [verb, seat] = parsed.positionals;
  if (verb !== 'start' && verb !== 'stop') throw new CliError(USAGE, 2);
  if (!seat) throw new CliError(`${USAGE}\nname the seat, e.g. musterd shift ${verb} ryder`, 2);
  const { team, identity, http } = resolve(parsed.flags);
  const body = verb === 'start' ? 'Start' : 'Stop';
  const envelope = makeEnvelope({
    id: ulid(),
    team,
    from: identity.name,
    to: { kind: 'member', name: seat },
    act: 'steer',
    body,
    meta: { quick_action: verb },
  });
  await sendOrEcho(() => http.send(team, envelope), { act: 'steer', body });
  process.stdout.write(
    success(
      verb === 'start'
        ? `${seat} is on shift — it works its claimed lanes until hours end, its day budget is spent, or the work runs out`
        : `${seat} is going off shift — a wake already running finishes first`,
      { next: 'musterd status' },
    ) + '\n',
  );
  return 0;
}
