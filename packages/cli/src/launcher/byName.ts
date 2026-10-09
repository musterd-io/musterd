import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { flagStr, type Parsed } from '../args.js';
import { loadBinding, loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { describeMirror, mirrorRepoServers } from '../onboard/repoServers.js';
import { nearestCommand } from '../render/help.js';
import { buildCatalog, type Catalog } from './catalog.js';
import {
  fetchRoster,
  liveFor,
  localWake,
  viewerNameFor,
  type Live,
  type LocalWake,
} from './live.js';
import { planLaunch, type LaunchPlan } from './plan.js';
import { resolveSeatWord } from './resolve.js';
import {
  describeMove,
  formatReceipt,
  liveQuestion,
  liveSummary,
  wakeMenu,
  wakeReason,
} from './rows.js';
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
import { stopWake } from './yield.js';

export interface LaunchOptions {
  mode: 'fresh' | 'resume';
  harness: string | null;
  /** Skip the live check — `--force`, or the picker already asked. On a wake it takes over. */
  force: boolean;
  /** `--take-over`: stop the live local wake and continue its conversation (ADR 546). */
  takeOver?: boolean;
  /** `--watch`: follow the live local wake read-only (ADR 546). */
  watch?: boolean;
}

/** What a person chose to do about a live local wake (ADR 546). */
export type WakeChoice = 'take-over' | 'watch' | 'cancel';

/** How watching a wake ended (ADR 546). */
export type WatchEnd = 'take-over' | 'leave' | 'finished' | 'ended';

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
  /** The repo-server mirror run before a launch (ADR 529; tests). */
  mirror?: typeof mirrorRepoServers;
  /** Finds the live local wake (ADR 546; tests). */
  localWake?: typeof localWake;
  /** The take over / watch / cancel choice on a TTY (ADR 546; tests). */
  choose?: (lines: string[]) => Promise<WakeChoice>;
  /** Asks a wake to stop (ADR 546; tests). */
  stopWake?: typeof stopWake;
  /** Follows a wake read-only (ADR 546; tests). */
  watch?: (wake: LocalWake, seat: Seat) => Promise<WatchEnd>;
  /** Plans the launch (tests). */
  plan?: typeof planLaunch;
}

/** What a take-over adds to the launch: the wake's conversation, and why the session exists. */
interface TakeOver {
  /** Absent for a native wake: it has no harness conversation to resume (ADR 546, lane 6/6). */
  session?: { harness: string; id: string };
  env: NodeJS.ProcessEnv;
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
    ...(parsed.flags['take-over'] === true ? { takeOver: true } : {}),
    ...(parsed.flags['watch'] === true ? { watch: true } : {}),
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
  // ADR 503 Decision 2: the same rule as the picker row — a folder here whose seat is resident on
  // another node is not launched from here; moving it is the guide's ceremony, never a side effect.
  const resident = (file.snapshot?.members ?? []).find(
    (m) =>
      m.team === res.seat.team &&
      m.member === res.seat.member &&
      m.can === 'none' &&
      (m.where === 'node' || m.where === 'cloud'),
  );
  if (resident) throw new CliError(`${res.seat.address} is ${describeMove(resident)}`, 1);
  return launchSeat(res.seat, opts, deps);
}

/** Live check → plan → record → supervise → record → receipt. Shared by the name path and the picker. */
export async function launchSeat(
  seat: Seat,
  opts: LaunchOptions,
  deps: LaunchDeps = {},
  takeOver?: TakeOver,
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

  // `--force` still reads the roster: on a wake it means take over (ADR 546), so it has to know.
  // A take-over's own relaunch (`takeOver` set) has just decided and skips the read.
  const live = takeOver
    ? null
    : liveFor(seat, await (deps.roster ?? fetchRoster)(seat.server, seat.team));
  // ADR 546: a wake on this machine is not "a live seat, open a second session?" — it is something a
  // person can take over or watch. Only with the wake's conversation id: an older host wrote none, and
  // resuming nothing is worse than the plain question below.
  const wake = live ? (deps.localWake ?? localWake)(seat, live) : null;
  if (live && wake && (wake.session_id || wake.in_process) && !takeOver) {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const choice: WakeChoice =
      opts.takeOver || opts.force
        ? 'take-over'
        : opts.watch
          ? 'watch'
          : isTTY
            ? await (deps.choose ?? chooseOnTTY)(wakeMenu(seat.member, live, now()))
            : refuseWake(seat, live, now());
    if (choice === 'cancel') return 0;
    const by = loadConfig().identities[seat.team]?.name ?? 'a person';
    const stop = async (): Promise<void> => {
      if ((await (deps.stopWake ?? stopWake)(wake, by)) === 'stuck')
        // Opening a second session beside a loop that is still running is the thing take-over exists
        // to prevent; the marker stays, so the loop still ends at its next tool boundary.
        throw new CliError(`${seat.member}'s wake did not stop in time — try again in a moment`, 1);
    };
    if (choice === 'watch') {
      const ended = await (deps.watch ?? defaultWatch)(wake, seat);
      if (ended === 'leave') return 0;
      // 'take-over' stops the wake; 'finished' / 'ended' mean it is already gone.
      if (ended === 'take-over') await stop();
    } else {
      await stop();
    }
    const tookOver = { MUSTERD_TOOK_OVER: wakeReason(live.wake).trim() || 'the wake' };
    // A native wake has no conversation to continue: the person gets a fresh session on the seat.
    if (wake.in_process || !wake.session_id)
      return launchSeat(seat, { mode: 'fresh', harness: opts.harness, force: true }, deps, {
        env: tookOver,
      });
    return launchSeat(seat, { mode: 'resume', harness: wake.harness, force: true }, deps, {
      session: { harness: wake.harness, id: wake.session_id },
      env: tookOver,
    });
  }
  if (!opts.force && live) {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY)
      throw new CliError(
        `${seat.member} is live ${liveSummary(live, now())} — pass --force to open a second session`,
        1,
      );
    const ok = await (deps.confirm ?? confirmOnTTY)(`${liveQuestion(seat.member, live, now())} `);
    if (!ok) return 0;
  }

  const binding = loadBinding(seat.path);
  const captured = binding.kind === 'valid' ? binding.value.session : undefined;
  const path = launcherFilePath(env);
  const plan = await (deps.plan ?? planLaunch)({
    seat,
    mode: opts.mode,
    harness: opts.harness,
    // A take-over resumes the WAKE's conversation, not the binding's captured one (ADR 546).
    session:
      takeOver?.session ?? (captured ? { harness: captured.harness, id: captured.id } : null),
    recent: readLauncherFile(path).seats[seat.address] ?? null,
    registry: seat.kind === 'human' ? [] : harnessAdapters(),
    env,
  });
  // The repo's own MCP servers (the whiteboard) reach this harness too (ADR 529). Best-effort:
  // a mirror hiccup never blocks a launch.
  if (seat.kind !== 'human') {
    try {
      const line = describeMirror(await (deps.mirror ?? mirrorRepoServers)(seat.path));
      if (line) err(`${line}\n`);
    } catch {
      /* the next launch retries */
    }
  }
  if (takeOver) plan.env = { ...plan.env, ...takeOver.env };
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

/** The refusal off a TTY when a wake holds the seat: how to take it over or watch it (ADR 546). */
function refuseWake(seat: Seat, live: Live, now: number): never {
  throw new CliError(
    `${seat.member} is live ${liveSummary(live, now)} — pass --take-over to continue its conversation, ` +
      `--watch to follow it, or --force`,
    1,
  );
}

/** The watch view, loaded on demand so the launcher's paint path never pays for it (ADR 546). */
async function defaultWatch(wake: LocalWake, seat: Seat): Promise<WatchEnd> {
  return (await import('./watch/index.js')).watchWake(wake, seat);
}

/**
 * One keypress: ⏎ take over, `w` watch, esc or ⌃C cancel (ADR 546). Raw mode, restored on every
 * exit path; anything else is ignored rather than guessed at.
 */
async function chooseOnTTY(lines: string[]): Promise<WakeChoice> {
  process.stderr.write(lines.join('\n') + '\n');
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<WakeChoice>((resolve) => {
      const onData = (buf: Buffer): void => {
        const k = buf.toString();
        const choice: WakeChoice | null =
          k === '\r' || k === '\n'
            ? 'take-over'
            : k === 'w' || k === 'W'
              ? 'watch'
              : k === '\u001b' || k === '\u0003'
                ? 'cancel'
                : null;
        if (!choice) return;
        stdin.off('data', onData);
        resolve(choice);
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
}
