import { hostname } from 'node:os';
import { gitToplevel } from '@musterd/protocol/project';
import { z } from 'zod';
import type { Parsed } from '../args.js';
import { flagStr } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import type { ActuatorBackend } from '../host/backend.js';
import { claudeCodeBackend } from '../host/backends/claudeCode.js';
import { codexBackend } from '../host/backends/codex.js';
import { cursorAgentBackend } from '../host/backends/cursorAgent.js';
import { grokBackend } from '../host/backends/grok.js';
import { museBackend } from '../host/backends/muse.js';
import { nativeBackend } from '../host/backends/native.js';
import { opencodeBackend } from '../host/backends/opencode.js';
import { type DoorbellPollDeps, pollDoorbellOnce } from '../host/doorbell.js';
import { pollHostOnce, type HostPollDeps } from '../host/loop.js';
import { provisionOnce, type ProvisionDeps } from '../host/provisioner.js';
import { hostRegistryPath, loadHostRegistry } from '../host/registry.js';
import { HARNESSES } from '../onboard/harnesses/index.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';
import { ensureHostKey } from './residency.js';

/**
 * `musterd host [--once]` (ADR 131, increment 3) — the wake actuator: the resident, per-machine
 * loop that makes enrolled seats actually wakeable. The `musterd notify` shape: poll the daemon
 * (agent-key, presence-neutral), spawn the harness in the seat's own workspace, verify from the
 * roster, kill on watchdog, report. The daemon decides *who* is due (lanes, cooldowns, caps,
 * leases); this process only ever executes reachability policy — it never decides work (ADR 131
 * §7, the no-orchestrator principle). LaunchAgent management lands with increment 5's service
 * label; until then it runs in a terminal, exactly like `notify`.
 */

const HostOptionsSchema = z.object({
  /** Poll cadence (seconds → ms). The floor keeps a typo from hammering the daemon; the poll is
   *  also the immediate-lane wake-latency floor, so the default leans tight. */
  intervalMs: z.number().int().min(2_000).max(3_600_000).default(10_000),
  /** The mandatory watchdog bound on each wake run (seconds → ms). */
  timeoutMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
  once: z.boolean().default(false),
});

function parseOptions(flags: Record<string, string | boolean>): z.infer<typeof HostOptionsSchema> {
  const secs = (name: string): number | undefined => {
    const raw = flags[name];
    const n = typeof raw === 'string' ? Number(raw) : undefined;
    return n != null && Number.isFinite(n) ? Math.round(n * 1000) : undefined;
  };
  return HostOptionsSchema.parse({
    intervalMs: secs('interval'),
    timeoutMs: secs('timeout'),
    once: flags['once'] === true,
  });
}

/**
 * The provisioner's wiring (ADR 463 §3): who this host is, and which identity acts for it. Reads the
 * host's OWN workspace — the folder `musterd host` runs in — for the sponsor's binding, the checkout
 * that new agents are worktree'd from, and a host-scoped credential (minted once, kept in the
 * binding as `host_key`). Anything that means "this host has no sponsor to provision for" — no
 * binding, not a repo, a credential the daemon refuses to mint — returns null: the wake half runs
 * exactly as it always did, and the host says nothing.
 */
/**
 * ADR 648: the cloud host's provisioner. No sponsor binding exists on musterd compute — and
 * must never — so one host-key client performs the claim, the provisioning steps and the
 * report, under the authority ADR 648 scopes to the key creator's sponsored seats. The key
 * arrives in `MUSTERD_HOST_KEY` (a machine secret, never logged); server, team and host label
 * are flags, the harness defaults to the resident engine (`musterd`).
 */
export async function buildCloudProvisioner(
  parsed: Parsed,
  log: (line: string) => void,
  seams: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    clientFor?: (server: string, key: string) => HttpClient;
  } = {},
): Promise<((now?: number) => ReturnType<typeof provisionOnce>) | null> {
  const env = seams.env ?? process.env;
  const server = flagStr(parsed.flags, 'server');
  const team = flagStr(parsed.flags, 'team');
  const host = flagStr(parsed.flags, 'host');
  const hostKey = env['MUSTERD_HOST_KEY'];
  if (!server || !team || !host || !hostKey) {
    log('! cloud provisioning is off: --server, --team, --host and MUSTERD_HOST_KEY are required');
    return null;
  }
  const cwd = seams.cwd ?? process.cwd();
  const repoRoot = gitToplevel(cwd);
  if (!repoRoot) {
    log('! cloud provisioning is off: this folder is not a git checkout');
    return null;
  }
  const harnessId = flagStr(parsed.flags, 'harness') ?? 'musterd';
  // The resident engine is not in the selectable HARNESSES list; provisioning uses only its id
  // (the enrolment's harness and the wiring label), so the native row is named directly.
  const harness =
    harnessId === 'musterd'
      ? ({ id: 'musterd', label: 'musterd (resident engine)' } as ProvisionDeps['harness'])
      : HARNESSES.find((h) => h.id === harnessId);
  if (!harness) {
    log(`! cloud provisioning is off: unknown harness "${harnessId}"`);
    return null;
  }
  const client = (
    seams.clientFor ??
    ((s: string, key: string) => new HttpClient({ server: s, key }).presenceNeutral())
  )(server, hostKey);
  const base: Omit<ProvisionDeps, 'log'> = {
    client: client as ProvisionDeps['client'],
    // ADR 648: the host key itself is the provisioning caller — no sponsor identity here.
    sponsor: client as ProvisionDeps['sponsor'],
    team,
    server,
    host,
    hostKey,
    harness,
    repoRoot,
    clone: parsed.flags['clone'] !== false,
  };
  return () => provisionOnce({ ...base, log });
}

export async function buildProvisioner(
  parsed: Parsed,
  log: (line: string) => void,
  seams: {
    resolveIdentity?: typeof resolve;
    cwd?: string;
    hostLabel?: string;
    clientFor?: (
      server: string,
      key: string,
    ) => Pick<HttpClient, 'claimProvisions' | 'reportProvision'>;
  } = {},
): Promise<((now?: number) => ReturnType<typeof provisionOnce>) | null> {
  try {
    const cwd = seams.cwd ?? process.cwd();
    const { team, http } = (seams.resolveIdentity ?? resolve)(parsed.flags);
    const binding = findBinding(cwd);
    const repoRoot = gitToplevel(cwd);
    if (!binding || !repoRoot) return null;
    const host = seams.hostLabel ?? flagStr(parsed.flags, 'host') ?? hostname();
    const hostKey = await ensureHostKey(binding, host, async (label) => {
      const minted = await http.mintBootstrapCredential(team, {
        use: 'host',
        target: label,
        label: `provision:${label}`,
      });
      return minted.agent_key;
    });
    if (hostKey !== binding.host_key) saveBinding(cwd, { ...binding, host_key: hostKey });
    const harnessId = binding.session?.harness ?? 'claude-code';
    const harness =
      HARNESSES.find((h) => h.id === harnessId) ?? HARNESSES.find((h) => h.id === 'claude-code');
    if (!harness) return null;
    const client = (
      seams.clientFor ?? ((server, key) => new HttpClient({ server, key }).presenceNeutral())
    )(binding.server, hostKey);
    const base: Omit<ProvisionDeps, 'log'> = {
      client: client as ProvisionDeps['client'],
      sponsor: http,
      team,
      server: binding.server,
      host,
      hostKey,
      harness,
      repoRoot,
      clone: parsed.flags['clone'] === true,
    };
    return () => provisionOnce({ ...base, log });
  } catch (err) {
    // Not a sponsor's host (an agent's folder, an unbound one, a daemon that refuses the mint):
    // provisioning is simply off. Only a genuinely unexpected failure is worth a line.
    if (!(err instanceof CliError)) log(`! provisioning is off: ${(err as Error).message}`);
    return null;
  }
}

/** `musterd host provisions` — what this host key may see, claimed by nobody (ADR 463 §3). */
async function provisionsCommand(parsed: Parsed): Promise<number> {
  const { team } = resolve(parsed.flags);
  const cwd = process.cwd();
  const binding = findBinding(cwd);
  const host = flagStr(parsed.flags, 'host') ?? hostname();
  const key = binding?.host_key;
  if (!binding || !key) {
    throw new CliError(
      'no host credential here — run `musterd host` once in this folder (it mints one), ' +
        'or pass through a sponsor’s Workspace',
      4,
    );
  }
  const { provisions } = await new HttpClient({ server: binding.server, key })
    .presenceNeutral()
    .listProvisions(team, host);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ host, provisions }) + '\n');
    return 0;
  }
  if (provisions.length === 0) {
    process.stdout.write(theme.meta(`no provisions for ${host}`) + '\n');
    return 0;
  }
  for (const p of provisions) {
    process.stdout.write(
      `${p.id} · ${p.agent} · ${p.state}${p.failed_reason ? ` · ${p.failed_reason}` : ''}\n`,
    );
  }
  return 0;
}

const HOST_USAGE =
  'usage: musterd host [provisions] [--once] [--interval <s>] [--timeout <s>] [--host <label>] [--no-provision] [--cloud-provision --server <url> --team <slug>] [--no-gateway] [--clone] — ' +
  '`musterd host` runs the wake actuator; `musterd host provisions` lists claimable provisions. ' +
  'There is no `host status`: read ~/.musterd/host.log, or `musterd service status --wake`.';

export async function hostCommand(
  parsed: Parsed,
  deps: Partial<HostPollDeps & DoorbellPollDeps> & {
    /** `false` runs the wake half alone — the doorbell never polls a daemon. */
    doorbell?: boolean;
    /** Injectable provisioner tick (tests); `null` disables. Default: built from this folder. */
    provisioner?: (() => ReturnType<typeof provisionOnce>) | null;
  } = {},
): Promise<number> {
  if (parsed.positionals[0] === 'provisions') return provisionsCommand(parsed);
  // Lane 01M3QTE5235VK1NNQBSSZ28ZZ1: `host` runs the actuator when it has no positional, so a
  // mistyped or imagined subcommand (`host status`) used to start a SECOND actuator in this
  // workspace, silently, forever — polling leases and provisioning under this seat's key. An
  // unknown positional is a usage error, before any backend or key is touched.
  if (parsed.positionals.length > 0) throw new CliError(HOST_USAGE, 2);
  const opts = parseOptions(parsed.flags);
  const backends = new Map<string, ActuatorBackend>();
  const claude = claudeCodeBackend();
  backends.set(claude.harness, claude);
  const codex = codexBackend();
  backends.set(codex.harness, codex);
  const opencode = opencodeBackend();
  backends.set(opencode.harness, opencode);
  const grok = grokBackend();
  backends.set(grok.harness, grok);
  const muse = museBackend();
  backends.set(muse.harness, muse);
  const cursor = cursorAgentBackend();
  backends.set(cursor.harness, cursor);
  // The native row (ADR 251): selected only by an enrollment that explicitly says
  // `harness: musterd` — registered here, never a default (a native wake spends real dollars
  // against the configured model; phase-1 rollout is opt-in per enrollment).
  const native = nativeBackend();
  backends.set(native.harness, native);

  const log = deps.log ?? ((line: string) => process.stdout.write(theme.meta(`  ${line}`) + '\n'));
  const hostLabel = flagStr(parsed.flags, 'host');
  // Lane 01M3QRYZM2: aborted on SIGTERM/SIGINT so a poll in progress hands back the orders it has
  // not started instead of stranding them until the lease TTL.
  const stop = new AbortController();
  const pollDeps: HostPollDeps = {
    backends,
    bounds: { timeout_ms: opts.timeoutMs },
    // ADR 583: every wake runs behind the metering gateway unless the operator says otherwise.
    ...(parsed.flags['no-gateway'] === true ? { gateway: false as const } : {}),
    log,
    signal: stop.signal,
    // Lane 01M41NQ05V: one memo for the actuator's life, so a hub seat's deferral logs once.
    deferralsLogged: new Map(),
    ...(hostLabel !== undefined ? { hostLabel } : {}),
    ...deps,
  };

  // ADR 463 §3: a sponsor's host provisions new agents as they are created, each tick, after the
  // wake half's lease claim. On by default; `--no-provision` opts out. Built once — the host key is
  // minted (and kept) at most once — and a null result leaves the wake half exactly as it was.
  const provisionTick: (() => ReturnType<typeof provisionOnce>) | null =
    parsed.flags['no-provision'] === true
      ? null
      : deps.provisioner !== undefined
        ? deps.provisioner
        : parsed.flags['cloud-provision'] === true
          ? await buildCloudProvisioner(parsed, log)
          : await buildProvisioner(parsed, log);
  let provisioning: Promise<unknown> | null = null;
  // Its own catch, like the doorbell: a provisioning failure never stops a wake, and a slow
  // provision (a clone, a harness install) never delays one — the tick does not await it.
  const provision = (): Promise<unknown> => {
    if (provisionTick === null) return Promise.resolve();
    provisioning ??= provisionTick()
      .catch((err: Error) => log(`! provision tick failed: ${err.message}`))
      .finally(() => {
        provisioning = null;
      });
    return provisioning;
  };

  const registry = loadHostRegistry();
  if (registry.entries.length === 0 && provisionTick === null) {
    process.stdout.write(
      theme.warn(`no seats in this machine's host registry (${hostRegistryPath()})`) + '\n',
    );
    process.stdout.write(
      theme.meta('  run `musterd residency on` in each seat’s workspace, then start the host') +
        '\n',
    );
    if (opts.once) return 1;
  }

  // The doorbell's `os` sink (ADR 443 §3) rides the same tick: same registry, same labels, same
  // agent-key auth. Its own catch — a doorbell failure never stops a wake — and it never delays one:
  // the resident loop does not await it, and skips a tick's ring while the last one is still out.
  const doorbellDeps: DoorbellPollDeps = {
    log,
    ...(hostLabel !== undefined ? { hostLabel } : {}),
    ...deps,
  };
  let ringing: Promise<number> | null = null;
  const ringDoorbell = (): Promise<number> => {
    if (deps.doorbell === false) return Promise.resolve(0);
    ringing ??= pollDoorbellOnce(doorbellDeps)
      .catch((err: Error) => {
        log(`! doorbell poll failed: ${err.message}`);
        return 0;
      })
      .finally(() => {
        ringing = null;
      });
    return ringing;
  };

  if (opts.once) {
    const [, , result] = await Promise.all([ringDoorbell(), provision(), pollHostOnce(pollDeps)]);
    if (result.orders === 0) process.stdout.write(theme.meta('no wakes due') + '\n');
    // Await in-flight runs so the mandatory watchdog outlives every spawn (never orphaned).
    await Promise.allSettled(result.settled);
    return 0;
  }

  process.stdout.write(`${theme.accent('host')} — wake actuator  ${theme.ok('◉ polling')}\n`);
  process.stdout.write(
    theme.meta(
      `  ${registry.entries.length} seat(s) registered · every ${Math.round(opts.intervalMs / 1000)}s · ` +
        `watchdog ${Math.round(opts.timeoutMs / 1000)}s · Ctrl-C to stop`,
    ) + '\n',
  );
  return new Promise<number>((resolveP) => {
    let timer: NodeJS.Timeout | undefined;
    const inFlight = new Set<Promise<void>>();
    let stopping = false;
    const tick = async () => {
      void ringDoorbell();
      void provision();
      // Best-effort: a transient daemon/registry failure must not kill the resident loop.
      const result = await pollHostOnce(pollDeps).catch((err: Error) => {
        log(`! poll failed: ${err.message}`);
        return null;
      });
      for (const p of result?.settled ?? []) {
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
      }
      // NB: not unref'd — nothing else holds the event loop open (the `notify` lesson).
      if (!stopping) timer = setTimeout(tick, opts.intervalMs);
    };
    void tick();
    // SIGTERM is what `launchctl kickstart -k` (autorefresh, `service restart --wake`) sends; it
    // used to kill the actuator outright mid-poll (lane 01M3QRYZM2). Both signals now stop the
    // ticks, hand back unstarted orders (the abort), and wait for in-flight runs — launchd's
    // ExitTimeOut still bounds that wait.
    const onStop = () => {
      if (stopping) return;
      stopping = true;
      stop.abort();
      if (timer) clearTimeout(timer);
      process.stdout.write('\n');
      // In-flight wake runs keep their own watchdogs; report already went out per actuation.
      void Promise.allSettled([...inFlight]).then(() => resolveP(0));
      if (inFlight.size > 0) {
        process.stdout.write(
          theme.meta(`waiting for ${inFlight.size} wake run(s) to settle…`) + '\n',
        );
      }
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
  });
}
