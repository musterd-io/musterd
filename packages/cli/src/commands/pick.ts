import { execFile } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import { pickerRows, type Pick, type PickerView } from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { runScreen, type PickerIO } from '../launcher/picker/tty.js';
import { writePendingPick } from '../pick/marker.js';
import {
  initialPick,
  reducePick,
  type PickEvent,
  type PickOutcome,
  type PickState,
} from '../pick/state.js';
import { NARROW_HINT, pickTableLines } from '../pick/table.js';
import { clean } from '../pick/text.js';
import { MIN_COLS, renderLanePicker } from '../pick/view.js';
import { theme } from '../render/theme.js';
import { buildOpenCommand, surfaceUrl } from './board.js';
import { findWorkspaceDir, resolve, resolveRead } from './helpers.js';

/** Seams for the command tests: the in-process daemon has no terminal and no browser. */
export const pickSeams: {
  io: () => PickerIO;
  isTTY: () => boolean;
  cols: () => number;
  open: (url: string) => boolean;
  run: typeof runScreen;
} = {
  io: () => ({ input: process.stdin, output: process.stdout }),
  isTTY: () => process.stdout.isTTY === true && process.stdin.isTTY === true,
  cols: () => process.stdout.columns ?? 80,
  open: (url) => {
    const command = buildOpenCommand(osPlatform(), url);
    if (!command) return false;
    execFile(command.cmd, command.args, () => {
      /* best effort — the URL is printed either way */
    });
    return true;
  },
  run: runScreen,
};

/**
 * `musterd pick` — the lane picker (ADR 624/626, spec 2026-10-16). The board's open lanes,
 * rendered by musterd, for the seat whose workspace this is; the human picks one and the seat gets
 * it. On a terminal it is a two-pane screen. Without one (an agent's shell tool) it prints the same
 * rows as a table, and `--open` sends the human to the /live lane picker for this seat instead.
 */
/** The flags `musterd pick` takes; `pnpm cli-flags:check` proves the list covers every read. */
/**
 * The flags `musterd pick` takes (lane
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
export const PICK_FLAGS = ['blocked', 'claimable', 'for-human', 'http', 'open'] as const;

export async function pickCommand(parsed: Parsed): Promise<number> {
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...PICK_FLAGS],
    'the flags `musterd pick` takes are listed by `musterd help pick`',
  );
  const { team, identity, http, explicit } = resolve(parsed.flags);
  if (!explicit)
    throw new CliError(
      'musterd pick runs in a seat’s workspace — it picks for the seat bound here, and this folder has none',
      2,
    );
  const seat = identity.name;
  const read = async (): Promise<PickerView> =>
    pickerRows(await http.laneBoard(team, {}), seat, Date.now());
  const view = await read();

  if (parsed.flags['open'] === true || !pickSeams.isTTY() || pickSeams.cols() < MIN_COLS) {
    process.stdout.write(pickTableLines(view, team, false).join('\n') + '\n');
    if (parsed.flags['open'] === true) {
      const { server } = resolveRead(parsed.flags);
      const url = `${surfaceUrl(server, team, 'live')}&pick=${encodeURIComponent(seat)}`;
      const opened = pickSeams.open(url);
      process.stdout.write(
        `\n${opened ? theme.accent('opening the lane picker') : 'the lane picker is at'} ${url}\n`,
      );
    } else if (pickSeams.isTTY()) {
      process.stdout.write(theme.meta(`\n${NARROW_HINT}\n`));
    }
    return 0;
  }

  const requester = await whoIsPicking(parsed, team, http, identity.name);
  let state: PickState = initialPick(team, seat, view, Date.now());
  for (;;) {
    let last = state;
    const outcome = await pickSeams.run<PickState, PickEvent, PickOutcome>(
      {
        initial: state,
        reduce: (s, e) => {
          const step = reducePick(s, e);
          last = step.state;
          return step;
        },
        render: renderLanePicker,
        quit: (code) => ({ kind: 'quit', code }),
      },
      pickSeams.io(),
      () => undefined,
    );
    if (outcome.kind === 'quit') return outcome.code;

    // Re-read the lane: the screen may have been open a while (spec §6, the race).
    const now = Date.now();
    const fresh = (await http.laneShow(team, outcome.row.id)).lane;
    if (fresh.state !== 'open' || fresh.owner_seat !== null) {
      const when = fresh.claimed_at
        ? ` ${Math.max(0, Math.round((now - fresh.claimed_at) / 1000))}s ago`
        : '';
      state = {
        ...last,
        view: await read(),
        notice: `${outcome.row.short} was taken by ${fresh.owner_seat ?? fresh.state}${when} — pick another`,
      };
      continue;
    }
    const pick: Pick = {
      via: 'terminal',
      requested_by: requester.name,
      attested: requester.self,
      ...(process.env['MUSTERD_LAUNCH_SURFACE']
        ? { harness: process.env['MUSTERD_LAUNCH_SURFACE'].slice(0, 32) }
        : {}),
      at: now,
    };
    try {
      await http.updateLane(team, outcome.row.id, { owner_seat: seat, pick });
    } catch (err) {
      state = {
        ...last,
        view: await read(),
        notice: err instanceof Error ? err.message : String(err),
      };
      continue;
    }
    // ADR 626: the seat hears a terminal pick from its own workspace, at its next interrupt check.
    // A human picking for themselves needs no notice — they are the one who will do it.
    const dir = findWorkspaceDir();
    if (!requester.self && dir)
      writePendingPick(dir, {
        lane: outcome.row.id,
        title: outcome.row.title,
        requested_by: requester.name,
        at: now,
      });
    process.stdout.write(
      `${theme.ok('✓')} picked ${outcome.row.short} "${clean(outcome.row.title)}" for ${seat}` +
        (requester.self ? '\n' : ` — requested by ${requester.name}, unattested (ADR 624)\n`),
    );
    return 0;
  }
}

/**
 * Who asked for this pick. A human picking in their own workspace is the requester, and that is
 * provable. In an agent's workspace the human cannot be proven (ADR 442), so the name is recorded
 * unattested: the team's one human, or `--for-human <name>` when there are several. Never guessed.
 */
async function whoIsPicking(
  parsed: Parsed,
  team: string,
  http: ReturnType<typeof resolve>['http'],
  seat: string,
): Promise<{ name: string; self: boolean }> {
  const roster = await http.roster(team);
  const me = roster.members.find((m) => m.name === seat);
  if (me?.kind === 'human') return { name: seat, self: true };
  const humans = roster.members.filter((m) => m.kind === 'human').map((m) => m.name);
  const named = flagStr(parsed.flags, 'for-human');
  if (named !== undefined) {
    if (!humans.includes(named))
      throw new CliError(
        `--for-human ${named}: no human of that name on ${team} (${humans.join(', ') || 'none'})`,
        2,
      );
    return { name: named, self: false };
  }
  if (humans.length === 1) return { name: humans[0]!, self: false };
  throw new CliError(
    humans.length === 0
      ? `${team} has no human member — a pick records who asked, and nobody here can`
      : `${team} has ${humans.length} humans (${humans.join(', ')}) — say who is picking: musterd pick --for-human <name>`,
    2,
  );
}
