import { spawn as nodeSpawn } from 'node:child_process';
import { CliError } from '../errors.js';
import { plainLabel } from './rows.js';
import type { MemberEntry, Seat } from './store.js';

/*
 * The doorbell from the front door (ADR 503 Decision 2, `can: wake`): `⏎` on a seat resident on
 * another machine sends an ordinary `steer` to it. It runs as the viewer — `musterd send` in the
 * viewer's own human Workspace here, so the credential is that Workspace's binding (ADR 442: a
 * folder's binding or env is the only identity; nothing here reaches into a vault). The act carries
 * `launch_surface=picker` in meta so the share of doorbells rung from the launcher can be read later.
 */

export interface WakeDeps {
  spawn?: typeof nodeSpawn;
  /** This CLI's own entry: `process.execPath` + `process.argv[1]`. */
  bin?: { exec: string; entry: string };
  err?: (s: string) => void;
}

/** The viewer's working human Workspace on `team`, here — the credential a doorbell is rung with. */
export function viewerSeatFor(
  team: string,
  seats: readonly Seat[],
  viewer: string | null,
): Seat | null {
  const humans = seats.filter((s) => s.team === team && s.kind === 'human' && s.problem === null);
  if (viewer) return humans.find((s) => s.member === viewer) ?? null;
  return humans.length === 1 ? humans[0]! : null;
}

/** Ring the doorbell. Resolves to the `musterd send` exit code. */
export async function wakeMember(
  entry: MemberEntry,
  seats: readonly Seat[],
  viewer: string | null,
  deps: WakeDeps = {},
): Promise<number> {
  const from = viewerSeatFor(entry.team, seats, viewer);
  if (!from)
    throw new CliError(
      `${entry.member} is ${describeWhereShort(entry)} — ring it from your own seat here: musterd human <you>, then try again`,
      1,
    );
  const bin = deps.bin ?? { exec: process.execPath, entry: process.argv[1] ?? '' };
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const body = `doorbell from ${from.member} at the launcher — ${entry.member}, are you up?`;
  const args = [
    bin.entry,
    'send',
    '--to',
    entry.member,
    '--act',
    'steer',
    '--meta',
    'launch_surface=picker',
    body,
  ];
  err(`ringing ${entry.member} (${describeWhereShort(entry)}) as ${from.member}…\n`);
  const code = await new Promise<number>((resolve) => {
    const child = (deps.spawn ?? nodeSpawn)(bin.exec, args, {
      cwd: from.path,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c ?? 1));
  });
  return code;
}

function describeWhereShort(entry: Pick<MemberEntry, 'where' | 'where_label'>): string {
  return entry.where === 'cloud'
    ? 'in the cloud'
    : `on ${entry.where_label ? plainLabel(entry.where_label) : 'another machine'}`;
}
