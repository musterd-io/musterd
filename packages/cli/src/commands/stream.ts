/**
 * `musterd stream` — go live from a rented machine, in one verb.
 *
 * The hosted broadcast worked on 2026-07-27, and going live still cost five manual setup steps, an
 * environment variable, a shell script and a hand-edited LaunchAgent plist. nick's ask, verbatim:
 * *"We will need an extremely simple flow to do all of this stuff btw."* This is that flow — it
 * absorbs `scripts/broadcast/live.sh` and puts a `doctor` in front of it.
 *
 * `doctor` is the centrepiece, not a courtesy. Four launches failed that day, and every one
 * presented as the same unhelpful line — *"the broadcast page never reported ready"* — while the
 * actual cause was a missing `tailscale serve` forward, a daemon that wasn't allow-listing the
 * tailnet `Host`, an app config the builder demanded, or a tag that resolved to a stale digest.
 * Preconditions that fail invisibly need a command that makes them visible, with the repair printed.
 *
 * Sibling to `musterd broadcast`, not a mode of it: `broadcast` captures and encodes on **this**
 * machine; `stream` runs that same capture on a **rented** one and manages its lifetime. Different
 * failure modes, different preconditions, so a different verb.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Parsed } from '../args.js';
import { GLOBAL_FLAGS, rejectUnknownFlags } from '../args.js';
import {
  DEFAULT_APP,
  describeStaleness,
  findRepoRoot,
  imageStaleness,
  prepareBuildSource,
  formatFlyExit,
  parseFlyExit,
  parseLaunchedMachine,
  parsePushedDigest,
  readCaptureImage,
  writeCaptureImage,
  REGION,
  runChecks,
  occupiedMachines,
  startedMachines,
  VM_SIZE,
  type Check,
  type FlyExit,
} from '../broadcast/hosted.js';
import {
  FLAP_MAX,
  FLAP_WINDOW_MS,
  decideEnsure,
  standDownReport,
  readStreamState,
  writeStreamState,
} from '../broadcast/streamState.js';
import { HttpClient } from '../client.js';
import { configPath, loadConfig, serverProvenance, type ServerProvenance } from '../config.js';
import { CliError } from '../errors.js';
import { probeUpgradeHost, parseTailscaleSelf } from '../integrations/tailscale.js';
import { realExec, type Exec } from '../process.js';
import { theme } from '../render/theme.js';
import { mintBroadcastSeat, seatFromEnv, type BroadcastSeat } from './broadcast.js';
import { resolveRead } from './helpers.js';

const USAGE =
  'usage: musterd stream <doctor|build|start|stop|status|ensure> [--app <name>] [--team <slug>] [--here] [--once] [--reason <text>] [--json]';

export interface StreamDeps {
  exec?: Exec;
  probeUpgrade?: (hostHeader: string) => Promise<'allowed' | 'rejected' | 'unreachable'>;
  cwd?: string;
  /** Where the daemon listens, for the upgrade probe. Defaults to the configured server. */
  server?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** The desired-state file (ADR 293). Defaults to `~/.musterd/stream/state.json`. */
  statePath?: string;
  now?: () => number;
  /** Who is running this verb — the CLI's resolved seat, recorded as stop/start provenance. */
  who?: () => string;
  /** Run `fly machine run` with these args; returns the exit code. Injected so tests never
   * reach the real Fly API (the default inherits stdio for the interactive `start`). */
  launch?: (flyArgs: string[]) => LaunchResult | Promise<LaunchResult>;
  sleep?: (ms: number) => Promise<void>;
  /** Raise the stand-down ask to the team (streamwatch service seat; ADR 293). */
  sendAsk?: (body: string) => Promise<void>;
  /** The last `stream.exit` the dead machine posted (lane 01M52Z987280), null when none is
   * reachable — the supervisor merges it into the crash note and the stand-down ask. */
  fetchEpitaph?: (team: string) => Promise<StreamEpitaph | null>;
  /** Mint the stream's public-grade observer (ADR 594). Injected so tests never reach a daemon. */
  mintSeat?: (team: string) => Promise<BroadcastSeat>;
  /** Stage the seat as the app's MUSTERD_BROADCAST_SEAT Fly secret, over stdin (ADR 594). */
  stageSeat?: (app: string, seat: BroadcastSeat) => { code: number; output: string };
}

/** The daemon's loopback origin — the upgrade probe aims here and spoofs only the `Host` header. */
function daemonOrigin(server: string): { hostname: string; port: number } {
  try {
    const u = new URL(server);
    return { hostname: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
  } catch {
    return { hostname: '127.0.0.1', port: 4849 };
  }
}

/**
 * The flags `musterd stream` takes (lane
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
export const STREAM_FLAGS = [
  '--json',
  'allowed',
  'allowed-host',
  'app',
  'auth',
  'capture-nodes',
  'close',
  'data',
  'error',
  'fly',
  'fly-auth',
  'git',
  'image',
  'inherit',
  'pipe',
  'reason',
  'response',
  'secrets',
  'serve',
  'source',
  'status',
  'stream',
  'tailnet',
  'timeout',
  'unreachable',
  'upgrade',
  'version',
  'whoami',
] as const;

export async function streamCommand(parsed: Parsed, deps: StreamDeps = {}): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...STREAM_FLAGS],
    'the flags `musterd stream` takes are listed by `musterd help stream`',
  );
  const sub = parsed.positionals[0];
  if (!sub) throw new CliError(USAGE, 2);

  const exec = deps.exec ?? realExec;
  const cwd = deps.cwd ?? process.cwd();
  const server = deps.server ?? loadConfig().server;
  const origin = daemonOrigin(server);
  const probeUpgrade =
    deps.probeUpgrade ?? ((hostHeader: string) => probeUpgradeHost(origin, hostHeader));
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const app = typeof parsed.flags['app'] === 'string' ? parsed.flags['app'] : DEFAULT_APP;
  const repoRoot = findRepoRoot(cwd);
  const statePath = deps.statePath ?? join(dirname(configPath()), 'stream', 'state.json');
  const now = deps.now ?? (() => Date.now());
  const who = deps.who ?? (() => currentSeatName(parsed.flags));
  const launch = deps.launch ?? realLaunch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sendAsk = deps.sendAsk ?? defaultSendAsk;
  const fetchEpitaph = deps.fetchEpitaph ?? defaultFetchEpitaph;
  const mintSeat =
    deps.mintSeat ??
    (async (team: string) => seatFromEnv(team) ?? (await mintBroadcastSeat(parsed.flags, team)));
  const stageSeat = deps.stageSeat ?? realStageSeat;
  const sup = { statePath, now, who, launch, sleep, sendAsk, fetchEpitaph, mintSeat, stageSeat };

  switch (sub) {
    case 'doctor':
      return doctorVerb({
        exec,
        probeUpgrade,
        app,
        port: origin.port,
        repoRoot,
        statePath,
        out,
        json: parsed.flags['json'] === true,
        // Only when the CALLER did not name the server: an injected/flagged one has no provenance
        // question, and the doctor's own checks are about the resolved origin either way.
        ...(deps.server ? {} : { provenance: serverProvenance(cwd) }),
      });
    case 'build':
      return buildVerb({
        exec,
        app,
        repoRoot,
        statePath,
        now,
        out,
        here: parsed.flags['here'] === true,
      });
    case 'start':
      return startVerb({ exec, app, repoRoot, parsed, out, err, ...sup });
    case 'stop':
      return stopVerb({ exec, app, parsed, out, ...sup });
    case 'status':
      return statusVerb({ exec, app, out, ...sup });
    case 'ensure':
      return ensureVerb({ exec, app, repoRoot, parsed, out, err, ...sup });
    default:
      throw new CliError(`unknown subcommand \`${sub}\`\n${USAGE}`, 2);
  }
}

// ── doctor ───────────────────────────────────────────────────────────────────────────────────────

async function doctorVerb(a: {
  exec: Exec;
  probeUpgrade: (h: string) => Promise<'allowed' | 'rejected' | 'unreachable'>;
  app: string;
  port: number;
  repoRoot: string | null;
  statePath: string;
  out: (s: string) => void;
  json: boolean;
  provenance?: ServerProvenance;
}): Promise<number> {
  const checks = await runChecks({
    exec: a.exec,
    probeUpgrade: a.probeUpgrade,
    app: a.app,
    port: a.port,
    repoRoot: a.repoRoot,
    // The image the SUPERVISOR would launch, not this checkout's file — a doctor that answers
    // about its own worktree reads green while the stream would run something else entirely.
    image: readCaptureImage({ statePath: a.statePath, repoRoot: a.repoRoot }),
  });
  const failed = checks.filter((c) => c.state === 'fail');

  if (a.json) {
    a.out(JSON.stringify({ ok: failed.length === 0, checks }) + '\n');
    return failed.length === 0 ? 0 : 1;
  }

  a.out(`${theme.accent('stream doctor')} ${theme.meta(`— ${a.app}`)}\n\n`);
  // Say which daemon these checks are ABOUT before printing them. Every check below resolves from
  // the machine-wide default, so when that default is wrong (2026-08-12: a probe's `team create`
  // repointed it) the doctor fails correctly about somebody else's port — and prescribes real
  // repairs for infrastructure that is fine. The binding line is the tell.
  if (a.provenance) {
    a.out(theme.meta(`  daemon: ${a.provenance.server} (${a.provenance.source})\n`));
    if (a.provenance.disagreeingBinding) {
      a.out(
        `  ${theme.warn('!')} this folder is bound to ${theme.accent(a.provenance.disagreeingBinding.server)} ` +
          `(${a.provenance.disagreeingBinding.team}) — the checks below are about the ${a.provenance.source}\n`,
      );
    }
    a.out('\n');
  }
  for (const c of checks) a.out(renderCheck(c));

  if (failed.length === 0) {
    a.out(`\n${theme.ok('✓')} ready — \`musterd stream start\` will go live\n`);
    return 0;
  }
  // The fixes are reprinted together at the bottom because that block is the thing an operator
  // actually copies; interleaved with nine check lines it is easy to miss the second one.
  const noun = failed.length === 1 ? 'thing' : 'things';
  a.out(`\n${theme.err(`✗ ${failed.length} ${noun} to fix, in order:`)}\n\n`);
  for (const c of failed) {
    a.out(`  ${theme.bold(c.label)}\n`);
    for (const line of (c.fix ?? '').split('\n')) a.out(`    ${theme.accent(line)}\n`);
  }
  return 1;
}

function renderCheck(c: Check): string {
  const mark =
    c.state === 'ok' ? theme.ok('✓') : c.state === 'fail' ? theme.err('✗') : theme.meta('·');
  const detail = c.detail ? theme.meta(` — ${c.detail}`) : '';
  return `${mark} ${c.label}${detail}\n`;
}

// ── build ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build + push the capture image on Fly's remote builders (nothing touches Docker locally), then
 * record the pushed digest.
 *
 * The digest is the point. A rebuilt `:capture` tag resolved to the *previous* digest and two
 * machines silently streamed month-old code; `start` runs the recorded digest, which cannot be stale.
 * `-c hosted.fly.toml` is not optional either — `--build-only` still validates an app config, and a
 * fresh app has no machines to infer one from.
 *
 * It builds `origin/main` from a clean export unless `--here` says to build this folder
 * (`prepareBuildSource`), and records the commit it built either way.
 */
async function buildVerb(a: {
  exec: Exec;
  app: string;
  repoRoot: string | null;
  statePath: string;
  now: () => number;
  out: (s: string) => void;
  here: boolean;
}): Promise<number> {
  const root = requireRepo(a.repoRoot);
  const source = prepareBuildSource({ exec: a.exec, root, here: a.here });
  try {
    a.out(theme.meta(`building ${source.label}`) + '\n');
    if (a.here)
      a.out(theme.warn('⚠ --here ships this folder as it stands, not origin/main') + '\n');
    return await buildFrom(a, root, source.dir, source.commit);
  } finally {
    source.cleanup();
  }
}

async function buildFrom(
  a: { app: string; statePath: string; now: () => number; out: (s: string) => void },
  root: string,
  dir: string,
  commit: string | null,
): Promise<number> {
  a.out(theme.meta('building on fly remote builders…') + '\n');
  // BOTH streams are scanned for the digest, and that is not defensive coding — flyctl prints the
  // `capture@sha256:…` line on stderr, so watching stdout alone found nothing and the guard below
  // refused every build. (live.sh got this right with `2>&1 | tee /dev/stderr`; porting it, I kept
  // the tee and lost the redirect.) Streamed through as it arrives rather than captured and dumped,
  // because a remote build runs for minutes and silence reads as a hang.
  const combined = await new Promise<{ code: number; text: string }>((resolve) => {
    const child = spawn(
      'fly',
      [
        'deploy',
        '.',
        '-a',
        a.app,
        '-c',
        'scripts/broadcast/hosted.fly.toml',
        '--build-only',
        '--push',
        '--remote-only',
        '--image-label',
        'capture',
      ],
      { cwd: dir, stdio: ['inherit', 'pipe', 'pipe'] },
    );
    let text = '';
    child.stdout?.on('data', (d: Buffer) => {
      text += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      text += d.toString();
      process.stderr.write(d);
    });
    child.on('error', () => resolve({ code: 127, text }));
    child.on('close', (code) => resolve({ code: code ?? 1, text }));
  });
  if (combined.code !== 0) throw new CliError('fly build failed — see the output above', 1);
  const digest = parsePushedDigest(combined.text);
  if (!digest) {
    throw new CliError(
      'the build succeeded but no digest appeared in its output — refusing to record a tag ' +
        '(a tag can resolve to a stale image; a digest cannot)',
      1,
    );
  }
  // Recorded ONCE PER MACHINE, beside `state.json` — not in this checkout. Whichever worktree ran
  // the build, `start`, `ensure` and the supervisor all read the same record (lane 01M2RAJ0JK).
  // The commit too, so `doctor` can tell an image built before the capture code it needs (lane
  // 01M50D71N1). That is the commit the source held: origin/main's tip, or HEAD under --here.
  writeCaptureImage({
    statePath: a.statePath,
    digest,
    repoRoot: root,
    now: a.now(),
    ...(commit ? { commit } : {}),
  });
  a.out(`${theme.ok('✓')} built ${theme.meta(digest.slice(0, 19))} — recorded for this machine\n`);
  return 0;
}

// ── start ────────────────────────────────────────────────────────────────────────────────────────

/** The injected supervisor plumbing every desired-state verb shares (ADR 293). */
interface Sup {
  statePath: string;
  now: () => number;
  who: () => string;
  launch: (flyArgs: string[]) => LaunchResult | Promise<LaunchResult>;
  sleep: (ms: number) => Promise<void>;
  sendAsk: (body: string) => Promise<void>;
  fetchEpitaph: (team: string) => Promise<StreamEpitaph | null>;
  mintSeat: (team: string) => Promise<BroadcastSeat>;
  stageSeat: (app: string, seat: BroadcastSeat) => { code: number; output: string };
}

/**
 * Stage the stream's observer as an app secret (ADR 594). Through stdin, never argv or `--env`: argv
 * shows in `ps` and `--env` lands in the machine config, both readable without the secret store.
 * `--stage` writes it without restarting anything; the next `machine run` — start's, or the
 * supervisor's relaunch — gets it, so streamwatch (an agent seat that cannot mint) never needs it.
 */
function realStageSeat(app: string, seat: BroadcastSeat): { code: number; output: string } {
  const r = spawnSync('fly', ['secrets', 'import', '-a', app, '--stage'], {
    input: `MUSTERD_BROADCAST_SEAT=${JSON.stringify(seat)}\n`,
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** The `fly machine run` invocation, shared by `start` and the supervisor's relaunch. */
function launchArgs(a: {
  app: string;
  digest: string;
  addr: string;
  team: string;
  extra?: string | undefined;
}): string[] {
  return [
    'machine',
    'run',
    `registry.fly.io/${a.app}:capture@${a.digest}`,
    '-a',
    a.app,
    '--vm-size',
    VM_SIZE,
    '--region',
    REGION,
    // Machine lifetime = stream lifetime: `--rm` destroys it when the process exits, so `stop`,
    // the ADR 159 stall watchdog and `--duration` all end the billing too. `fly deploy` is
    // deliberately not used here — it silently creates a standby machine as well.
    '--rm',
    '--restart',
    'no',
    '--env',
    `MUSTERD_AIR_ADDR=${a.addr}`,
    '--env',
    `MUSTERD_TEAM=${a.team}`,
    ...(a.extra ? ['--env', `BROADCAST_ARGS=${a.extra}`] : []),
  ];
}

/** Resolve the launch preconditions (image digest + tailnet address) or throw the doctor hint. */
function launchPreconditions(a: { exec: Exec; repoRoot: string | null; statePath: string }): {
  digest: string;
  addr: string;
} {
  // Deliberately NOT `requireRepo`: the image is a property of the machine now, so a launch does
  // not need to be standing in a checkout to know which one to run.
  const image = readCaptureImage({ statePath: a.statePath, repoRoot: a.repoRoot });
  const digest = image?.digest;
  if (!digest) throw new CliError('no image recorded — run `musterd stream build` first', 2);
  // The address is discovered, never demanded. Requiring MUSTERD_AIR_ADDR meant every launch began
  // by looking up a name the machine already knows.
  const addr = tailnetAddr(a.exec);
  if (!addr) {
    throw new CliError(
      'could not read this machine’s tailnet address from `tailscale status` — run `musterd stream doctor`',
      2,
    );
  }
  return { digest, addr };
}

async function startVerb(
  a: {
    exec: Exec;
    app: string;
    repoRoot: string | null;
    parsed: Parsed;
    out: (s: string) => void;
    err: (s: string) => void;
  } & Sup,
): Promise<number> {
  // `occupied`, not `started`: a machine that is still booting already holds the Twitch key, and
  // asking the running question during its ~29s boot returns a false empty that lets this launch a
  // second one beside it (2026-09-03).
  const live = occupiedMachines(machineListJson(a.exec, a.app));
  if (live.length > 0) {
    throw new CliError(`already live (machine ${live[0]}) — \`musterd stream stop\` first`, 1);
  }
  const { digest, addr } = launchPreconditions(a);
  // Warn, never block: a deliberate run on an older image is the operator's call. `doctor` is
  // where a stale image fails (lane 01M50D71N1).
  const image = readCaptureImage({ statePath: a.statePath, repoRoot: a.repoRoot });
  const stale = image?.source === 'machine' ? imageStaleness(a.exec, a.repoRoot, image) : null;
  if (stale && stale.kind !== 'current') {
    a.err(
      `${theme.warn('!')} capture image ${describeStaleness(stale)} — \`musterd stream build\` first if the stream must run current code\n`,
    );
  }
  const team =
    (typeof a.parsed.flags['team'] === 'string' ? a.parsed.flags['team'] : undefined) ??
    process.env['MUSTERD_TEAM'] ??
    'revive';
  const extra =
    typeof a.parsed.flags['args'] === 'string'
      ? a.parsed.flags['args']
      : process.env['BROADCAST_ARGS'];

  // Minted on this machine, by the operator, before intent is recorded: the box has no identity of
  // its own, and since ADR 580 the page cannot mint one over the tailnet's loopback forward. A refusal
  // here must leave no "live" intent behind for the supervisor to relaunch seatless.
  const seat = await a.mintSeat(team);
  const staged = a.stageSeat(a.app, seat);
  if (staged.code !== 0) {
    throw new CliError(
      `could not stage the stream's observer as a Fly secret — ${staged.output}`,
      1,
    );
  }

  // Intent is recorded BEFORE the launch (ADR 293): a start that fails at `fly` still says "this
  // stream should be live", and the supervisor's next tick retries it inside the flap budget. The
  // exception is `--once` — a deliberately unsupervised run records `stopped` so nothing ever
  // resurrects it (time-boxed `--duration` streams ride this).
  const once = a.parsed.flags['once'] === true;
  writeStreamState(
    a.statePath,
    once
      ? { desired: 'stopped', by: a.who(), at: a.now(), reason: '--once run', team, restarts: [] }
      : {
          desired: 'live',
          by: a.who(),
          at: a.now(),
          team,
          image: digest,
          restarts: [],
          ...(extra ? { args: extra } : {}),
        },
  );

  a.out(
    `${theme.accent('stream')} ${theme.meta(`${team} · via ${addr} · ${VM_SIZE} ${REGION}`)}\n`,
  );
  const args = launchArgs({ app: a.app, digest, addr, team, extra });
  // Captured across every attempt so the `finally` can record whichever machine the attempt left,
  // including one whose output named an id and then threw.
  let launchedOutput = '';

  /**
   * Did this attempt leave a machine behind, and did it come up?
   *
   * A MANIFEST_UNKNOWN exit does NOT mean no machine was created. `fly machine run` creates the
   * machine and THEN the VM fails to pull a digest the registry has not published yet; the machine
   * keeps trying and comes up on its own once the registry catches up (observed live 2026-09-15:
   * the "failed" first attempt's machine went live 52s later, unaided). Relaunching over the top of
   * it puts a second performance-4x beside a healthy one, both publishing to the same key — the
   * 2026-09-03 duplicate-launch, reached through `start`'s own retry.
   *
   * But "a machine exists" is NOT "a machine works", and conflating them is how this guard would
   * lie. `isUnpropagatedImage` matches every MANIFEST_UNKNOWN, including a digest that is
   * permanently unresolvable (registry GC, a stale `.image-digest`, wrong registry auth). That
   * machine sits in `created` forever — and `created` is an OCCUPYING state, so returning 0 here
   * would report `◉ live`, and `ensure`'s `liveCount > 0` would then read `noop — live` on every
   * tick from now on. `start` would exit 0, the supervisor would never fire, and nobody would
   * stream. Before this guard existed that input failed loudly on the first try, which was right.
   *
   * So: wait for the machine to actually reach `started`, for the budget the retry loop would have
   * spent anyway. Come up → success. Still not up when the budget is gone → fail, loudly, with the
   * machine named so the operator can look at it.
   */
  async function settleLeftoverMachine(): Promise<'none' | 'started' | 'stuck'> {
    const left = occupiedMachines(machineListJson(a.exec, a.app));
    if (left.length === 0) return 'none';
    if (left.length > 1) {
      // Two machines here means something else launched in the window between the state write and
      // this read — the supervisor's own tick is the candidate. Say it rather than picking one:
      // this is the duplicate this command exists to avoid, and a silent `◉ live` would hide it.
      a.err(
        `${theme.warn('⚠')} ${theme.meta(
          `${left.length} machines are occupying ${a.app} (${left.join(', ')}) — ` +
            'that is a duplicate launch; stop all but one with `musterd stream stop`',
        )}\n`,
      );
    }
    a.out(
      `${theme.meta(
        `◇ machine ${left[0]} exists but is not up yet — the registry has not published ` +
          `${digest.slice(7, 15)}. Waiting for it instead of launching a second.`,
      )}\n`,
    );
    for (let tick = 0; tick < LAUNCH_RETRIES; tick++) {
      await a.sleep(LAUNCH_RETRY_DELAY_MS);
      if (startedMachines(machineListJson(a.exec, a.app)).length > 0) return 'started';
    }
    return 'stuck';
  }

  try {
    let result = await a.launch(args);
    launchedOutput = result.output;
    for (let attempt = 1; attempt <= LAUNCH_RETRIES && result.code !== 0; attempt++) {
      if (!isUnpropagatedImage(result.output)) break;
      const settled = await settleLeftoverMachine();
      if (settled === 'started') {
        a.out(
          `${theme.ok('◉ live')} ${theme.meta(`watch: fly logs -a ${a.app} · end: musterd stream stop`)}\n`,
        );
        return 0;
      }
      if (settled === 'stuck') {
        throw new CliError(
          `a machine was created but never started — ${digest.slice(7, 15)} is not resolvable from ` +
            `the registry. This is not publish lag. Check \`fly logs -a ${a.app}\` and the recorded ` +
            'digest, then `musterd stream stop` the stuck machine.',
          1,
        );
      }
      a.out(
        `${theme.warn('↻')} ${theme.meta(
          `the registry has not published ${digest.slice(7, 15)} yet — retrying in ` +
            `${LAUNCH_RETRY_DELAY_MS / 1000}s (${attempt}/${LAUNCH_RETRIES})`,
        )}\n`,
      );
      await a.sleep(LAUNCH_RETRY_DELAY_MS);
      result = await a.launch(args);
      launchedOutput = result.output;
    }
    // The LAST attempt's leftovers need the same question asked. Without this, an exhausted loop
    // throws while a machine is booting, and the operator's next `stream start` is refused
    // "already live (machine …)" — exit 1 over a machine that was about to work.
    if (result.code !== 0 && isUnpropagatedImage(result.output)) {
      const settled = await settleLeftoverMachine();
      if (settled === 'started') {
        a.out(
          `${theme.ok('◉ live')} ${theme.meta(`watch: fly logs -a ${a.app} · end: musterd stream stop`)}\n`,
        );
        return 0;
      }
      if (settled === 'stuck') {
        throw new CliError(
          `a machine was created but never started — ${digest.slice(7, 15)} is not resolvable from ` +
            `the registry. This is not publish lag. Check \`fly logs -a ${a.app}\` and the recorded ` +
            'digest, then `musterd stream stop` the stuck machine.',
          1,
        );
      }
    }
    if (result.code !== 0) throw new CliError('fly machine run failed — see the output above', 1);
    a.out(
      `${theme.ok('◉ live')} ${theme.meta(`watch: fly logs -a ${a.app} · end: musterd stream stop`)}\n`,
    );
    return 0;
  } finally {
    // Re-reads state: a stop that landed during the launch must not be rewritten as live.
    rememberLaunched(a, launchedOutput);
  }
}

/** What a launch attempt reported: its exit code, and the output the retry decision reads. */
export interface LaunchResult {
  code: number;
  output: string;
}

/** How many times `start` re-attempts a launch the registry is not ready for, and the wait between.
 * Sized against the observation that cost the 2026-09-03 restart: two failures, then success about
 * four minutes after the push, with nothing changed in between. */
const LAUNCH_RETRIES = 4;
const LAUNCH_RETRY_DELAY_MS = 45_000;

/**
 * Is this failure the registry not having caught up with a digest we just pushed?
 *
 * Deliberately narrow. `stream build` pushes a digest and `start` pins it — which is the whole point
 * (a tag can resolve to a stale image; a digest cannot) — but the manifest is not immediately
 * resolvable everywhere, and flyctl reports that as a 404 `MANIFEST_UNKNOWN` even while its own
 * `image found:` line says it resolved. That heals itself in minutes.
 *
 * Everything else stays fatal on the first try. A retry loop over real errors — no capacity, bad
 * secrets, a broken entrypoint — is how you bill for machines that were never going to run.
 */
export function isUnpropagatedImage(output: string): boolean {
  return /MANIFEST_UNKNOWN|manifest unknown/i.test(output);
}

/** The real launcher: output is teed to the operator as it arrives AND captured, because the retry
 * decision has to read the failure and a `fly machine run` is slow enough that silence reads as a
 * hang. (Same shape, and the same reason, as the build verb above.) */
async function realLaunch(flyArgs: string[]): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    const child = spawn('fly', flyArgs, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => {
      output += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      output += d.toString();
      process.stderr.write(d);
    });
    child.on('error', () => resolve({ code: 127, output }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * The `by` on start/stop provenance: the seat the INVOKING folder resolves to, the same answer
 * `musterd whoami` gives there (ADR 442 — a folder is the member it is bound to, or nobody). It once
 * read the machine-global config's `current`, so a stop run from miley's workspace was recorded as
 * whoever last claimed on the laptop (lane 01M3TDDDET).
 */
export function currentSeatName(flags: Record<string, string | boolean>): string {
  try {
    return resolveRead(flags).identity?.name ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** This machine's MagicDNS name, which is what the container puts in `Host`. */
function tailnetAddr(exec: Exec): string | null {
  const st = exec('tailscale', ['status', '--json']);
  if (st.code !== 0) return null;
  const self = parseTailscaleSelf(st.stdout);
  return self?.running ? self.dnsName : null;
}

// ── stop / status ────────────────────────────────────────────────────────────────────────────────

function machineListJson(exec: Exec, app: string): string {
  const r = exec('fly', ['machine', 'list', '-a', app, '--json']);
  return r.code === 0 ? r.stdout : '[]';
}

function stopVerb(
  a: { exec: Exec; app: string; parsed: Parsed; out: (s: string) => void } & Sup,
): number {
  // The stop record is written FIRST, whatever the machine list says: even mid-race with the
  // supervisor, a deliberate stop can never be resurrected — and a stop typed at an already-dead
  // stream (a crash the human noticed first) still records "this silence is intentional".
  const reason =
    typeof a.parsed.flags['reason'] === 'string' ? a.parsed.flags['reason'] : undefined;
  const prev = readStreamState(a.statePath);
  writeStreamState(a.statePath, {
    desired: 'stopped',
    by: a.who(),
    at: a.now(),
    ...(reason ? { reason } : {}),
    ...(prev?.team ? { team: prev.team } : {}),
    restarts: [],
  });
  // Same question as `start`'s guard, so the same answer: stopping during the boot window used to
  // report "nothing live" and walk away from a machine that then came up and billed unattended.
  const live = occupiedMachines(machineListJson(a.exec, a.app));
  const machine = live[0];
  if (!machine) {
    a.out(theme.meta('○ nothing live') + '\n');
    return 0;
  }
  // SIGINT is the broadcast CLI's graceful stop (ADR 159): ffmpeg finalizes the container, Chrome
  // exits, the process ends, and `--rm` destroys the machine — which is what ends the billing.
  const r = a.exec('fly', [
    'machine',
    'stop',
    machine,
    '-a',
    a.app,
    '--signal',
    'SIGINT',
    '--timeout',
    '30',
  ]);
  if (r.code !== 0) throw new CliError(`could not stop machine ${machine}: ${r.stderr.trim()}`, 1);
  a.out(`${theme.ok('✓')} stopped ${machine} ${theme.meta('(machine self-destructs)')}\n`);
  return 0;
}

async function statusVerb(
  a: { exec: Exec; app: string; out: (s: string) => void } & Sup,
): Promise<number> {
  const live = startedMachines(machineListJson(a.exec, a.app));
  const state = readStreamState(a.statePath);
  if (live.length === 0) {
    // "Why did it die?" is the question a not-live status is being asked — answer it with the
    // stream's own last words when it left any (lane 01M52Z987280). No row: say nothing; the
    // "died without reporting" reading belongs to the supervisor's crash note, not a status poll.
    const ep = await a.fetchEpitaph(state?.team ?? process.env['MUSTERD_TEAM'] ?? 'revive');
    if (ep) {
      const ago = Math.round((a.now() - ep.ts) / 60_000);
      const when = ago < 1 ? 'just now' : ago < 90 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
      a.out(
        theme.meta(
          `  last end ${when} · exit ${ep.code} after ${Math.round(ep.ran_ms / 60_000)}m live — “${ep.reason}”`,
        ) + '\n',
      );
    }
    // Silence has three different meanings, and the bare "not live" hid all of them.
    if (state?.standDownAt !== undefined) {
      a.out(
        `${theme.err('⚠ stood down')} ${theme.meta(
          `after ${FLAP_MAX} restarts in ${FLAP_WINDOW_MS / 60_000}min — \`musterd stream start\` re-arms`,
        )}\n`,
      );
    } else if (state?.desired === 'live') {
      a.out(
        `${theme.warn('○ not live')} ${theme.meta(
          `but desired live — a crash; the supervisor restarts it within its tick${
            state.args ? ` · broadcast args kept (${state.args})` : ''
          }`,
        )}\n`,
      );
    } else if (state?.desired === 'stopped' && state.by) {
      const when = new Date(state.at).toLocaleTimeString();
      const why = state.reason ? ` · "${state.reason}"` : '';
      a.out(`${theme.meta(`○ stopped by ${state.by} · ${when}${why}`)}\n`);
    } else {
      a.out(theme.meta('○ not live') + '\n');
    }
    return 0;
  }
  a.out(
    `${theme.ok('◉ live')} ${theme.meta(
      `machine ${live.join(', ')} · ${a.app}${state?.args ? ` · ${state.args}` : ''}`,
    )}\n`,
  );
  return 0;
}

// ── ensure: the supervisor's reconcile tick (ADR 293) ───────────────────────────────────────────

/**
 * Actual vs desired, once: a machine gone while the state file says live is a crash — relaunch it
 * inside the flap budget, stand down (and ask a human) at the cap. Deliberate stops and `--once`
 * runs are `desired: stopped` and never touched. Silent on the healthy paths so the supervisor log
 * holds findings only, like the sweep's.
 */
async function ensureVerb(
  a: {
    exec: Exec;
    app: string;
    repoRoot: string | null;
    parsed: Parsed;
    out: (s: string) => void;
    err: (s: string) => void;
  } & Sup,
): Promise<number> {
  const state = readStreamState(a.statePath);
  // The id of the machine that just died, captured before any relaunch. `fly machine list` no
  // longer has it; the status lookup below is the only reader.
  const deadMachine = state?.machine;
  // The crash predicate asks whether a machine EXISTS, never whether it is up yet — a booting
  // machine read as absent is the 2026-09-03 duplicate-launch, where the supervisor put a second
  // performance-4x beside a healthy start and Twitch killed one of them.
  const occupying = occupiedMachines(machineListJson(a.exec, a.app));
  const liveCount = occupying.length;
  // The machine's record if there is one, this checkout's legacy file only if there is not — and
  // `decideEnsure` is told which, because a difference means something different in each case.
  const recorded = readCaptureImage({ statePath: a.statePath, repoRoot: a.repoRoot });
  const d = decideEnsure({
    state,
    liveCount,
    now: a.now(),
    recordedDigest: recorded?.digest ?? null,
    recordedDigestAt: recorded?.at ?? null,
    recordedDigestAuthoritative: recorded?.source === 'machine',
  });
  switch (d.action) {
    case 'noop':
      // A live tick is when the id is cheapest to learn. A stopped intent is not rewritten.
      if (occupying[0]) rememberMachine(a.statePath, occupying[0]);
      return 0;
    case 'stand_down': {
      writeStreamState(a.statePath, d.state);
      const lastWords = await crashClause(a, d.state.team, deadMachine);
      a.err(`${theme.err('⚠')} ${d.note.trimEnd()}${lastWords}\n`);
      try {
        // One sentence, composed once, from what was observed — the same one in the log line above.
        // These used to be two strings that disagreed: the log said "3 restarts", the ask said "the
        // broadcast crashed 3×", and the second is the only thing a human ever sees, because
        // standing down means the supervisor stops trying (lane 01M2K6BWVR).
        await a.sendAsk(
          `streamwatch: ${standDownReport(d.state, a.now())}${lastWords} — \`musterd stream doctor\` then ` +
            `\`musterd stream start\` to re-arm (attempts: ${d.state.restarts
              .map((t) => new Date(t).toLocaleTimeString())
              .join(', ')})`,
        );
      } catch (e) {
        a.err(
          theme.meta(`stand-down ask could not be sent (${(e as Error).message}) — logged only\n`),
        );
      }
      return 0;
    }
    case 'restart': {
      // The ledger is stamped BEFORE the launch: a launch that fails still spent an attempt, so a
      // hard-broken stream converges on stand-down instead of retrying forever.
      writeStreamState(a.statePath, d.state);
      // Only a crash earns the dead machine's last words — a deploy already named its cause.
      // The lookup uses the machine that died, never the id the relaunch below is about to print.
      const lastWords = d.cause === 'crash' ? await crashClause(a, d.state.team, deadMachine) : '';
      a.out(`${theme.warn('↻')} ${d.note.trimEnd()}${lastWords}\n`);
      // Relaunch the image the DECISION settled on, never whatever this checkout happens to hold.
      // `.image-digest` is per-checkout and streamwatch runs from the main one, so reading it here
      // is how a worktree-started stream came back 14 days old (2026-09-17). `d.state.image` is the
      // running image on a crash and the new one on a proven deploy; `launchPreconditions` stays
      // the fallback for legacy state with no `image`, and still supplies the tailnet address.
      const { digest: checkoutDigest, addr } = launchPreconditions(a);
      const digest = d.state.image ?? checkoutDigest;
      const team = d.state.team ?? process.env['MUSTERD_TEAM'] ?? 'revive';
      const { code, output } = await a.launch(
        launchArgs({ app: a.app, digest, addr, team, extra: d.state.args }),
      );
      if (code !== 0) {
        a.err(`${theme.err('✗')} relaunch failed (fly exit ${code}) — next tick retries\n`);
        // Keep WHY, not just that it happened. `output` was already on LaunchResult and already
        // printed here; throwing it away is what left the stand-down ask with nothing to report but
        // a guess. Recorded against the attempt it belongs to, and pruned with it.
        writeStreamState(a.statePath, {
          ...d.state,
          failures: [...(d.state.failures ?? []), { at: a.now(), code, error: output }],
        });
      } else a.out(`${theme.ok('◉ live again')} ${theme.meta(`machine relaunched · ${a.app}`)}\n`);
      // After the failure write, so that write cannot put the dead id back over the new one.
      // Re-reads: a stop during the relaunch is not overwritten with desired live.
      rememberLaunched(a, output);
      return 0;
    }
  }
}

/** The stand-down ask, sent as the `streamwatch` service seat (minted at `service install --stream`,
 * the guardian pattern). Unprovisioned → throw; the caller logs and degrades (ADR 232's shape). */
async function defaultSendAsk(body: string): Promise<void> {
  const tokenFile = join(dirname(configPath()), 'stream', 'seat-token');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const config = loadConfig();
  const team = config.current;
  if (!token || !team)
    throw new Error('no streamwatch seat token/team — run `musterd service install --stream`');
  const http = new HttpClient({ server: config.server, key: token, surface: 'cli' });
  await http.send(
    team,
    makeEnvelope({
      id: ulid(),
      team,
      from: 'streamwatch',
      to: { kind: 'team' },
      act: 'ask',
      body,
      meta: { species: 'consult', tier: 'standard' },
    }),
  );
}

/** One `stream.exit` row as the daemon returns it (lane 01M52Z987280). */
export interface StreamEpitaph {
  ts: number;
  seat: string;
  reason: string;
  code: number;
  ran_ms: number;
  machine?: string;
}

/** Read the newest epitaph as the streamwatch seat. Null on ANY failure — an unreadable epitaph
 *  and an unwritten one mean the same thing to the crash note: nothing honest to quote. */
async function defaultFetchEpitaph(team: string): Promise<StreamEpitaph | null> {
  try {
    const tokenFile = join(dirname(configPath()), 'stream', 'seat-token');
    const token = readFileSync(tokenFile, 'utf8').trim();
    const config = loadConfig();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(
        `${config.server}/teams/${encodeURIComponent(team)}/stream/epitaph?limit=1`,
        { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { epitaphs?: StreamEpitaph[] };
      return body.epitaphs?.[0] ?? null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** An epitaph older than this belongs to a previous run, not the death being reported. */
const EPITAPH_FRESH_MS = 15 * 60_000;

/**
 * The dead machine's last words as one clause for the crash note and the stand-down ask (lane
 * 01M52Z987280). Only a RECENT row counts — an epitaph from a run that ended hours ago would be
 * quoted against a newer death, the same mistake `standDownReport` exists to stop. No row is the
 * other half of the finding. When the state file still names the dead machine, that absence is
 * filled with the three facts Fly still prints — exit code, oom, requested stop (lane
 * 01M539NG4N) — and nothing Fly did not say. Fly returning nothing keeps the hard-kill sentence.
 */
export function lastWordsClause(
  ep: StreamEpitaph | null,
  now: number,
  fly: FlyExit | null = null,
): string {
  if (ep && now - ep.ts <= EPITAPH_FRESH_MS) {
    const mins = Math.round(ep.ran_ms / 60_000);
    return ` · last words (exit ${ep.code} after ${mins}m): “${ep.reason}”`;
  }
  if (fly) return ` · no last words — it died without reporting (${formatFlyExit(fly)})`;
  return ' · no last words — it died without reporting (a hard kill, or pre-epitaph capture code)';
}

/** Epitaph when it is fresh; otherwise Fly's exit event for the machine that died. */
async function crashClause(
  a: {
    exec: Exec;
    app: string;
    now: () => number;
    fetchEpitaph: (team: string) => Promise<StreamEpitaph | null>;
  },
  team: string | undefined,
  machine: string | undefined,
): Promise<string> {
  const ep = await a.fetchEpitaph(team ?? process.env['MUSTERD_TEAM'] ?? 'revive');
  const now = a.now();
  // A fresh epitaph already names the cause, so this tick skips the Fly lookup.
  const fly = ep && now - ep.ts <= EPITAPH_FRESH_MS ? null : readFlyExit(a.exec, a.app, machine);
  return lastWordsClause(ep, now, fly);
}

/** `fly machine status` text. Non-zero, or a table with no exit line, is nothing to quote. */
function readFlyExit(exec: Exec, app: string, machine: string | undefined): FlyExit | null {
  if (!machine) return null;
  const r = exec('fly', ['machine', 'status', machine, '-a', app]);
  if (r.code !== 0) return null;
  return parseFlyExit(`${r.stdout}\n${r.stderr}`);
}

/**
 * Record the machine id only while the intent is still live. Re-reads so a `stream stop` that
 * wrote `desired: stopped` during the launch is not overwritten — that write is the off-switch.
 */
function rememberMachine(statePath: string, id: string): void {
  const machine = id.toLowerCase();
  const cur = readStreamState(statePath);
  if (!cur || cur.desired !== 'live' || cur.machine === machine) return;
  if (!/^[0-9a-f]{4,}$/.test(machine)) return;
  writeStreamState(statePath, { ...cur, machine });
}

/** Prefer the id the launch printed. Fall back to whatever is occupying the app right now. */
function rememberLaunched(a: { exec: Exec; app: string; statePath: string }, output: string): void {
  const id = parseLaunchedMachine(output) ?? occupiedMachines(machineListJson(a.exec, a.app))[0];
  if (id) rememberMachine(a.statePath, id);
}

function requireRepo(repoRoot: string | null): string {
  if (repoRoot) return repoRoot;
  throw new CliError(
    'this verb builds from the musterd source tree — run it from inside a musterd checkout',
    2,
  );
}
