import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { flagStr, type Parsed } from '../args.js';
import { loadBinding, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { nearestCommand } from '../render/help.js';
import { buildCatalog, type Catalog } from './catalog.js';
import { fetchRoster, liveFor } from './live.js';
import { planLaunch, type LaunchPlan } from './plan.js';
import { resolveSeatWord } from './resolve.js';
import { describeLiveLong, formatReceipt } from './rows.js';
import {
  launcherFilePath,
  readLauncherFile,
  withExit,
  withLaunch,
  writeLauncherFile,
  type LauncherFile,
  type Seat,
} from './store.js';
import { supervise, type SuperviseResult } from './supervise.js';

export interface LaunchOptions {
  mode: 'fresh' | 'resume';
  harness: string | null;
  /** Skip the live check — `--force`, or the picker already asked. */
  force: boolean;
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
    throw unknownCommand(word, res.nearest);
  }
  if (res.kind === 'ambiguous') {
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
  const mode =
    parsed.positionals.includes('-r') || parsed.flags['resume'] !== undefined ? 'resume' : 'fresh';
  return launchSeat(
    res.seat,
    {
      mode,
      harness: flagStr(parsed.flags, 'harness') ?? null,
      force: parsed.flags['force'] === true,
    },
    deps,
  );
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
