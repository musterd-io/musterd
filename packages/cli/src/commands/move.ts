import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Envelope,
  type Lane,
  type MemberSummary,
  makeEnvelope,
  type MoveProvisionStatus,
  type SeatMoved,
  type SeatMoveRequest,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import {
  flagStr,
  GLOBAL_FLAGS,
  parseDurationMs,
  rejectUnknownFlags,
  type Parsed,
} from '../args.js';
import { loadConfig } from '../config.js';
import { CliError } from '../errors.js';
import { provisionAgentSeat } from '../onboard/agentSeat.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd move <seat> [--to <machine>]` — one command moves a seat between machines (ADR 696).
 *
 * Without `--to` the seat comes to THIS machine: the hub re-binds it here in one act, and this
 * command stands its Workspace up and re-enrolls its wake. With `--to` it is sent to an enrolled
 * machine by label or node id. When that machine's `musterd host` has polled within the staleness
 * window, this command waits for it to stand the Workspace up (ADR 703). Otherwise it prints the
 * finish to run there.
 *
 * A live seat is told first: a `steer` in its own thread asks it to push and save, and the move
 * waits up to `--wait` for its `accept` (`--now` skips). The hub's re-bind replaces the binding in
 * one transaction, so the old machine cannot take the seat back; its session ends when the new one
 * claims.
 */
// `--` and `ignore` are what cli-flags:check reads in the helpers `move` calls (git argv,
// `stdio: 'ignore'`); `agent`, `claim` and others declare them for the same reason.
export const MOVE_FLAGS = [
  '--',
  'dry-run',
  'harness',
  'ignore',
  'json',
  'now',
  'only',
  'to',
  'wait',
] as const;

const USAGE =
  'usage: musterd move <seat> [--to <machine>] [--now | --wait <dur>] [--only] [--harness <id>] [--dry-run] [--json]';

/** How long a live seat gets to push and reply before the move goes ahead (ADR 696 §3). */
export const DEFAULT_WRAP_UP_MS = 5 * 60_000;
/** How long `--to` waits for the target host to report before printing the finish (ADR 703). */
export const HOST_REPORT_WAIT_MS = 120_000;
const POLL_MS = 3_000;
const GIT = 'git';
const RESIDENCY_ON = 'on';

export type WrapUp = 'accepted' | 'timeout' | 'skipped' | 'not_live' | 'self';

/** What `runMove` reaches the world through — injected so the tests never touch a daemon or git. */
export interface MoveDeps {
  roster(): Promise<{ members: MemberSummary[]; node?: { id: string; label: string } | null }>;
  send(env: Envelope): Promise<void>;
  /** Envelopes received after `since`, oldest first. */
  messagesSince(since: number): Promise<Envelope[]>;
  /** The seat's open lanes (for the unpushed-branch warning). */
  lanesOf(seat: string): Promise<Lane[]>;
  /** True when `branch` exists on origin. Null when this machine cannot say (no git, no origin). */
  branchOnOrigin(branch: string): boolean | null;
  move(seat: string, body: SeatMoveRequest): Promise<SeatMoved>;
  /** The destination half (ADR 696 §4), run only when the seat came to this machine. */
  arrive(moved: SeatMoved, opts: { harness?: string }): Promise<string[]>;
  /** ADR 703: the move provision the target host is standing up. Absent in tests that predate it. */
  provisionStatus?(id: string): Promise<MoveProvisionStatus>;
  now(): number;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
}

export interface MoveInput {
  team: string;
  caller: string;
  seat: string;
  to?: string;
  now?: boolean;
  waitMs?: number;
  only?: boolean;
  harness?: string;
  dryRun?: boolean;
}

export interface MoveOutcome {
  moved: SeatMoved | null;
  wrapUp: WrapUp;
  unpushed: string[];
  arrived: string[];
}

export async function runMove(input: MoveInput, deps: MoveDeps): Promise<MoveOutcome> {
  const { members, node } = await deps.roster();
  const seat = members.find((m) => m.name === input.seat);
  if (!seat)
    throw new CliError(`no seat "${input.seat}" on ${input.team} — musterd status lists them`, 2);
  if (seat.kind !== 'agent' && seat.kind !== 'human')
    throw new CliError(
      `"${seat.name}" is a ${seat.kind} seat — a service belongs to its machine; install it there ` +
        '(musterd service install)',
      2,
    );
  if (seat.kind === 'human' && seat.name !== input.caller)
    throw new CliError(
      `"${seat.name}" is a person's seat — only ${seat.name} can add a machine to it (ADR 358)`,
      2,
    );
  const self = seat.name === input.caller;
  if (self && seat.kind === 'agent' && input.to === undefined)
    throw new CliError(
      `${seat.name} can send itself with --to <machine>; to bring it to this machine, run ` +
        `\`musterd move ${seat.name}\` from your own Workspace here`,
      2,
    );
  const here = input.to === undefined;
  const dest = here ? (node?.label ?? 'this machine') : input.to!;
  if (
    here &&
    seat.residence?.node &&
    node &&
    seat.residence.node === node.id &&
    seat.kind === 'agent'
  )
    deps.out(
      theme.meta(`${seat.name} already lives on ${dest} — re-checking its Workspace here\n`),
    );

  if (input.dryRun) {
    deps.out(
      `${theme.meta('dry run —')} would move ${seat.name} (${seat.kind}) from ` +
        `${seat.residence?.node_label ?? 'no machine yet'} to ${dest}` +
        (seat.presence !== 'offline' && !self ? ', after asking its live session to wrap up' : '') +
        '\n',
    );
    return { moved: null, wrapUp: 'skipped', unpushed: [], arrived: [] };
  }

  // §3: tell a live seat, then give it a bounded chance to push and say so.
  let wrapUp: WrapUp = 'not_live';
  if (self) wrapUp = 'self';
  else if (seat.presence !== 'offline' && seat.kind === 'agent') {
    if (input.now) wrapUp = 'skipped';
    else wrapUp = await askToWrapUp(input, seat.name, dest, deps);
  }
  const unpushed =
    seat.kind === 'agent' && wrapUp !== 'accepted' ? await unpushedBranches(seat.name, deps) : [];

  const moved = await deps.move(seat.name, {
    ...(input.to ? { to: input.to } : {}),
    ...(input.only ? { only: true } : {}),
  });
  // The answer must be about the seat we asked to move — everything below acts on `moved.seat`.
  if (moved.seat !== seat.name)
    throw new CliError(
      `the hub answered for "${moved.seat}", not "${seat.name}" — nothing was set up here`,
      1,
    );
  const from = moved.from.map((f) => f.label || f.node_id).join(', ') || 'no machine';
  deps.out(
    `${theme.ok(sym.ok)} ${seat.name} moved: ${from} → ${theme.accent(moved.to.label || moved.to.node_id)}\n`,
  );
  if (wrapUp === 'timeout')
    deps.out(
      `${theme.warn(sym.warn)} ${theme.warn(`${seat.name} did not answer within the wait — moved anyway`)}\n`,
    );
  for (const b of unpushed)
    deps.out(
      `${theme.warn(sym.warn)} ${theme.warn(`branch ${b} is not on origin — its work is still on the old machine; push it there`)}\n`,
    );

  const arrived = here
    ? await deps.arrive(moved, input.harness ? { harness: input.harness } : {})
    : [];
  for (const line of arrived) deps.out(line);
  if (!here && seat.kind === 'human')
    deps.out(
      success(`${moved.to.label} is now one of ${seat.name}'s machines`, {
        next: `on ${moved.to.label}: musterd human ${seat.name}  (a Workspace there, if you want one)`,
      }) + '\n',
    );
  else if (!here) {
    const handed = moved.provision;
    const status = handed ? await waitForMoveProvision(handed.id, deps) : null;
    if (handed && status?.state === 'ready') {
      deps.out(
        success(`${seat.name} is ready on ${moved.to.label}`, {
          next: `${handed.host} stood the Workspace up`,
        }) + '\n',
      );
    } else {
      const why =
        handed && (status?.state === 'failed' || status?.state === 'cancelled')
          ? `${handed.host} could not stand ${seat.name} up (${status.failed_reason ?? status.state})`
          : handed
            ? `${handed.host} did not finish standing ${seat.name} up`
            : undefined;
      await printFinish(seat.name, moved, deps, why);
    }
  }
  if (self && seat.kind === 'agent')
    deps.out(
      theme.meta(
        `this session is ${seat.name} on the old machine — end it once the new one is up\n`,
      ),
    );
  deps.out(
    theme.meta(
      `the harness session does not move (ADR 210); the seat's musterd memory does (ADR 366). ` +
        `The old Workspace stays where it was.\n`,
    ),
  );
  return { moved, wrapUp, unpushed, arrived };
}

/**
 * The commands to run on the target when no host there finished the move (ADR 703). The wake
 * enrollment the hub revoked does not come back by itself, so the finish carries it.
 */
async function finishCommands(seat: string, moved: SeatMoved): Promise<string[]> {
  const r = moved.residency;
  const finish = [`on ${moved.to.label}: musterd move ${seat}`];
  if (r && r.harness !== 'musterd') {
    // Lazy, as in `arrive`: a static import reads to cli-flags:check as `move` handing its flags on.
    const { policyFlags } = await import('./residency.js');
    finish[0] += ` --harness ${r.harness}`;
    finish.push(
      `then, in the Workspace it prints: musterd residency on --seat ${seat} --harness ${r.harness}` +
        [...(r.policy ? policyFlags(r.policy) : [])].map((a) => ` ${a}`).join(''),
    );
  } else if (r)
    finish.push(
      `then, in the Workspace it prints: musterd residency on --seat ${seat} --harness musterd --key-env <VAR>  (it ran on its own key, ADR 588)`,
    );
  return finish;
}

async function printFinish(
  seat: string,
  moved: SeatMoved,
  deps: MoveDeps,
  why?: string,
): Promise<void> {
  if (why) deps.out(`${theme.warn(sym.warn)} ${theme.warn(why)}\n`);
  const finish = await finishCommands(seat, moved);
  deps.out(
    success(`${seat} now belongs to ${moved.to.label}`, {
      next: finish.join('\n  '),
    }) + '\n',
  );
}

/** Poll until the host reports, or the wait runs out. A blip is not a failure. */
async function waitForMoveProvision(
  id: string,
  deps: MoveDeps,
): Promise<MoveProvisionStatus | null> {
  const ask = deps.provisionStatus;
  if (!ask) return null;
  const deadline = deps.now() + HOST_REPORT_WAIT_MS;
  let last: MoveProvisionStatus | null = null;
  while (deps.now() <= deadline) {
    try {
      last = await ask(id);
    } catch {
      // Keep the last answer. The finish is what a dead poll falls through to.
    }
    if (last && (last.state === 'ready' || last.state === 'failed' || last.state === 'cancelled'))
      return last;
    if (deps.now() >= deadline) break;
    await deps.sleep(POLL_MS);
  }
  return null;
}

async function askToWrapUp(
  input: MoveInput,
  seat: string,
  dest: string,
  deps: MoveDeps,
): Promise<WrapUp> {
  const id = ulid();
  const since = deps.now();
  await deps.send(
    makeEnvelope({
      id,
      team: input.team,
      from: input.caller,
      to: { kind: 'member', name: seat },
      act: 'steer',
      body:
        `moving you to ${dest} (musterd move, ADR 696): push your branch and save your seat ` +
        `memory, then reply accept to this. Your session here ends when the new one claims.`,
      thread: id,
      meta: null,
    }),
  );
  const waitMs = input.waitMs ?? DEFAULT_WRAP_UP_MS;
  deps.out(
    theme.meta(
      `asked ${seat} to wrap up — waiting up to ${Math.round(waitMs / 1000)}s for its accept (--now skips)\n`,
    ),
  );
  const deadline = since + waitMs;
  let cursor = since;
  while (deps.now() < deadline) {
    for (const env of await deps.messagesSince(cursor)) {
      cursor = Math.max(cursor, env.ts);
      const replyTo = (env.meta as { in_reply_to?: unknown } | null)?.in_reply_to;
      if (env.from === seat && (env.thread === id || replyTo === id) && env.act === 'accept')
        return 'accepted';
    }
    await deps.sleep(POLL_MS);
  }
  return 'timeout';
}

async function unpushedBranches(seat: string, deps: MoveDeps): Promise<string[]> {
  const out: string[] = [];
  for (const lane of await deps.lanesOf(seat)) {
    if (!lane.branch) continue;
    if (deps.branchOnOrigin(lane.branch) === false) out.push(lane.branch);
  }
  return out;
}

/** ADR 696 §4 step 3: a cold wake cannot answer Claude Code's folder-trust prompt (cloud-seat finding 8). */
export function preAcceptClaudeTrust(dir: string, file = join(homedir(), '.claude.json')): void {
  type ClaudeConfig = { projects?: Record<string, Record<string, unknown>> };
  const raw: ClaudeConfig = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as ClaudeConfig)
    : {};
  const projects = raw.projects ?? {};
  projects[dir] = {
    ...projects[dir],
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  writeFileSync(file, `${JSON.stringify({ ...raw, projects }, null, 2)}\n`);
}

export async function moveCommand(parsed: Parsed): Promise<number> {
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...MOVE_FLAGS],
    'the flags `musterd move` takes are listed by `musterd help move`',
  );
  const seatName = parsed.positionals[0];
  if (!seatName) throw new CliError(USAGE, 2);
  const waitRaw = flagStr(parsed.flags, 'wait');
  const { team, http, config, identity } = resolve(parsed.flags);
  if (!identity?.name)
    throw new CliError('no seat in this folder — run it from your own Workspace', 4);
  const caller = identity.name;
  const harness = flagStr(parsed.flags, 'harness');
  const to = flagStr(parsed.flags, 'to');

  const deps: MoveDeps = {
    roster: () => http.roster(team),
    send: async (env) => {
      await http.send(team, env);
    },
    messagesSince: async (since) =>
      (await http.messages(team, { since, limit: 200 })).messages
        .filter((m) => m.ts > since)
        .sort((a, b) => a.ts - b.ts),
    lanesOf: async (seat) =>
      (await http.laneBoard(team, { q: `owner:${seat}` })).lanes.filter(
        (l) => l.owner_seat === seat && l.state !== 'done' && l.state !== 'abandoned',
      ),
    branchOnOrigin: (branch) => {
      try {
        const lsRemote = ['ls-remote', '--heads', 'origin', branch];
        const outp = execFileSync(GIT, lsRemote, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
        });
        return outp.trim().length > 0;
      } catch {
        return null;
      }
    },
    move: (seat, body) => http.moveSeat(team, seat, body),
    provisionStatus: (id) => http.moveProvision(team, id),
    arrive: async (moved, opts) => {
      const lines: string[] = [];
      if (moved.kind === 'human') {
        lines.push(
          success(`${moved.seat} can now act from ${moved.to.label}`, {
            next: `musterd human ${moved.seat}  (a Workspace for you on this machine, if you want one)`,
          }) + '\n',
        );
        return lines;
      }
      const h = opts.harness ?? moved.residency?.harness ?? 'claude-code';
      const r = await provisionAgentSeat({
        name: moved.seat,
        team,
        server: config.server,
        http,
        harnesses: [h === 'musterd' ? 'claude-code' : h],
        toolkit: '',
        keepDesired: opts.harness === undefined,
        keepToolkit: true,
        sourceDir: process.cwd(),
        rosterHome: loadConfig().rosterHome[team],
      });
      const dir = r.workspace.dir;
      lines.push(`${theme.ok(sym.ok)} workspace ${dir}\n`);
      if (r.wiringError)
        lines.push(
          `${theme.warn(sym.warn)} ${theme.warn(`harness wiring incomplete (${r.wiringError}) — run musterd wire in ${dir}`)}\n`,
        );
      if (h === 'claude-code') {
        try {
          preAcceptClaudeTrust(dir);
        } catch (err) {
          lines.push(
            theme.warn(`  ! could not pre-accept Claude Code's folder trust: ${String(err)}\n`),
          );
        }
      }
      if (moved.residency) {
        if (moved.residency.harness === 'musterd') {
          lines.push(
            theme.warn(
              `  ! ${moved.seat} ran on its own key (ADR 588) — enroll it here with: musterd residency on ` +
                `--seat ${moved.seat} --workspace ${dir} --harness musterd --key-env <VAR>\n`,
            ),
          );
        } else {
          // The hub's answer is data, never argv: the Parsed is built field by field (a harness of
          // `--key-env` must not become a flag), and the harness must be one this CLI knows.
          const known = harnessAdapters().map((a) => a.id);
          if (!known.includes(moved.residency.harness))
            throw new CliError(
              `the hub returned an unknown harness "${moved.residency.harness}" for ${moved.seat} — ` +
                `nothing was enrolled; run musterd residency on there with one of: ${known.join(', ')}`,
              1,
            );
          // `residency on` gets a Parsed built here — never `move`'s own flags — so it is loaded
          // lazily, the way commandTable loads every command: a static import would read, to
          // cli-flags:check, as `move` handing its flags to residency and on to authority.
          const { residencyOn } = await import('./residency.js');
          await residencyOn(
            {
              positionals: [RESIDENCY_ON],
              flags: { seat: moved.seat, workspace: dir, harness: moved.residency.harness },
              metaPairs: [],
            },
            moved.residency.policy ? { policy: moved.residency.policy } : {},
          );
        }
      }
      lines.push(
        success(`${moved.seat} is ready on ${moved.to.label}`, { next: `musterd ${moved.seat}` }) +
          '\n',
      );
      return lines;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => process.stdout.write(line),
  };

  const outcome = await runMove(
    {
      team,
      caller,
      seat: seatName,
      ...(to ? { to } : {}),
      ...(parsed.flags['now'] === true ? { now: true } : {}),
      ...(waitRaw ? { waitMs: parseDurationMs(waitRaw, '--wait') } : {}),
      ...(parsed.flags['only'] === true ? { only: true } : {}),
      ...(harness ? { harness } : {}),
      ...(parsed.flags['dry-run'] === true ? { dryRun: true } : {}),
    },
    parsed.flags['json'] === true ? { ...deps, out: () => undefined } : deps,
  );
  if (parsed.flags['json'] === true)
    process.stdout.write(
      `${JSON.stringify({ moved: outcome.moved, wrap_up: outcome.wrapUp, unpushed: outcome.unpushed })}\n`,
    );
  return 0;
}
