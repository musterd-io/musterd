import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { flagStr, type Parsed } from '../args.js';
import { loadBinding, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { nearestCommand } from '../render/help.js';
import { buildCatalog, type Catalog } from './catalog.js';
import { fetchRoster, liveFor, viewerNameFor } from './live.js';
import { planLaunch, type LaunchPlan } from './plan.js';
import { resolveSeatWord } from './resolve.js';
import { describeLiveLong, describeMove, formatReceipt } from './rows.js';
import {
  launcherFilePath,
  readLauncherFile,
  withExit,
  withLaunch,
  writeLauncherFile,
  type LauncherFile,
  type MemberEntry,
  type Seat,
} from './store.js';
import { supervise, type SuperviseResult } from './supervise.js';
import { wakeMember } from './wake.js';

export interface LaunchOptions {
  mode: 'fresh' | 'resume';
  harness: string | null;
  /** Skip the live check — `--force`, or the picker already asked. */
  force: boolean;
}

/** What `openPicker` takes from the name path: the search, plus the flags typed with the name. */
export interface PickerOpenOptions {
  query: string;
  defaults?: { mode: 'fresh' | 'resume'; harness: string | null; force: boolean };
}

/** Seams (tests). Every default is the real thing. */
export interface LaunchDeps {
  catalog?: () => Catalog;
  roster?: typeof fetchRoster;
  supervise?: (plan: LaunchPlan) => Promise<SuperviseResult>;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The picker for an ambiguous name on a TTY (tests). */
  picker?: (opts: PickerOpenOptions) => Promise<number>;
  /** The doorbell for a seat resident elsewhere (tests). */
  wake?: typeof wakeMember;
}

/**
 * `musterd <word>` when the word is not a command (ADR 491 Decision 2). It returns BEFORE bin.ts's
 * postambles, so a launched session never pays for the reachability nudge or retitles the tab
 * under a seat name.
 */
export async function launchByName(
  word: string,
  parsed: Parsed,
  deps: LaunchDeps = {},
): Promise<number> {
  if (word.startsWith('-') && word !== '-') throw unknownCommand(word, null);
  const catalog = (deps.catalog ?? defaultCatalog)();
  const file = readLauncherFile(launcherFilePath(deps.env ?? process.env));
  const res = resolveSeatWord(word, catalog.seats, file.last);
  if (res.kind === 'none') {
    if (word === '-') throw new CliError('no seat launched yet — run `musterd` to pick one', 2);
    // ADR 503: a team member with no Workspace here follows the same `can` rule as the picker row.
    const away = (file.snapshot?.members ?? []).filter(
      (m) => m.address === null && m.member === word,
    );
    if (away.length === 1) return actOnMember(away[0]!, catalog.seats, deps);
    throw unknownCommand(word, res.nearest);
  }
  const mode =
    parsed.positionals.includes('-r') || parsed.flags['resume'] !== undefined ? 'resume' : 'fresh';
  const opts: LaunchOptions = {
    mode,
    harness: flagStr(parsed.flags, 'harness') ?? null,
    force: parsed.flags['force'] === true,
  };
  if (res.kind === 'ambiguous') {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    // `--path` prints a folder: the picker launches, so an ambiguous `--path` names the candidates.
    if (isTTY && parsed.flags['path'] === undefined) {
      const open =
        deps.picker ?? (async (o: PickerOpenOptions) => (await import('./index.js')).openPicker(o));
      return open({ query: word, defaults: opts });
    }
    throw new CliError(
      `"${word}" matches ${res.candidates.length} seats — name one:\n` +
        res.candidates.map((s) => `  musterd ${s.address}`).join('\n'),
      2,
    );
  }
  if (parsed.flags['path'] !== undefined) {
    (deps.out ?? ((s: string) => void process.stdout.write(s)))(`${res.seat.path}\n`);
    return 0;
  }
  return launchSeat(res.seat, opts, deps);
}

/** Live check → plan → record → supervise → record → receipt. Shared by the name path and the picker. */
export async function launchSeat(
  seat: Seat,
  opts: LaunchOptions,
  deps: LaunchDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  if (seat.problem) throw new CliError(`${seat.address} needs repair — ${seat.problem.fix}`, 1);
  // A picker row can come from a snapshot older than the folder (typed-ahead ⏎ before the scan).
  if (!existsSync(seat.path))
    throw new CliError(
      `${seat.address}: its Workspace folder is gone (${seat.path}) — musterd seats lists what is here`,
      1,
    );

  if (!opts.force) {
    const live = liveFor(seat, await (deps.roster ?? fetchRoster)(seat.server, seat.team));
    if (live) {
      const where = describeLiveLong(live, now());
      const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!isTTY)
        throw new CliError(
          `${seat.member} is live ${where} — pass --force to open a second session`,
          1,
        );
      const ok = await (deps.confirm ?? confirmOnTTY)(
        `${seat.member} is live ${where}. Open a second session in the same folder? (y/N) `,
      );
      if (!ok) return 0;
    }
  }

  const binding = loadBinding(seat.path);
  const captured = binding.kind === 'valid' ? binding.value.session : undefined;
  const path = launcherFilePath(env);
  const plan = await planLaunch({
    seat,
    mode: opts.mode,
    harness: opts.harness,
    session: captured ? { harness: captured.harness, id: captured.id } : null,
    recent: readLauncherFile(path).seats[seat.address] ?? null,
    registry: seat.kind === 'human' ? [] : harnessAdapters(),
    env,
  });
  record(path, (f) => withLaunch(f, seat, plan.harness, opts.mode, now()));
  const result = await (deps.supervise ?? supervise)(plan);
  record(path, (f) => withExit(f, seat.address, now(), result.code));
  err(formatReceipt(seat.member, plan.harness, result.durationMs, result.code) + '\n');
  return result.code;
}

/** `musterd <member>` for a seat with no folder here: wake it, say where it is, or say how to set it up. */
async function actOnMember(
  entry: MemberEntry,
  seats: readonly Seat[],
  deps: LaunchDeps,
): Promise<number> {
  if (entry.can === 'wake')
    return (deps.wake ?? wakeMember)(
      entry,
      seats,
      viewerNameFor(entry.team, loadConfig(), seats),
      deps.err ? { err: deps.err } : {},
    );
  if (entry.can === 'setup')
    throw new CliError(
      `${entry.member} has no Workspace here — set it up from the picker: musterd`,
      1,
    );
  throw new CliError(
    `${entry.member} is ${describeMove(entry)}${entry.can === 'none' && entry.where !== 'nowhere' ? '' : ' — nothing to do from here'}`,
    1,
  );
}

/** Read-modify-write, best-effort: recents are advisory and never fail a launch. */
function record(path: string, change: (f: LauncherFile) => LauncherFile): void {
  try {
    writeLauncherFile(path, change(readLauncherFile(path)));
  } catch {
    // advisory
  }
}

function defaultCatalog(): Catalog {
  return buildCatalog({ home: homedir(), config: loadConfig() });
}

function unknownCommand(word: string, nearestSeat: string | null): CliError {
  const near = nearestCommand(word);
  const hint = near
    ? ` — did you mean "${near}"?`
    : nearestSeat
      ? ` — did you mean the seat "${nearestSeat}"?`
      : '';
  return new CliError(`unknown command "${word}"${hint}  ·  musterd help`, 2);
}

async function confirmOnTTY(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
