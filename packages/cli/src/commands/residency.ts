import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  bindingSeat,
  type Binding,
  type PolicyOverride,
  type Residency,
  type ResidencyPolicy,
  type ResidencyPolicyOverride,
} from '@musterd/protocol';
import {
  flagStr,
  fmtBytes,
  fmtDurationMs,
  GLOBAL_FLAGS,
  parseDurationMs,
  rejectUnknownFlags,
  type Parsed,
} from '../args.js';
import { resolveClaudeBin } from '../claudeBin.js';
import { codexCapability, resolveCodexBin } from '../codexBin.js';
import { findBinding, loadConfig, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import {
  type HostRegistryEntry,
  hostRegistryPath,
  loadHostRegistry,
  removeHostEntry,
  upsertHostEntry,
} from '../host/registry.js';
import { keychainLookup, seatKeyService } from '../keychain.js';
import { opencodeCapability } from '../opencodeBin.js';
import { clock, theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { seatReachLines } from '../roster.js';
import { setPolicySigned } from './authority.js';
import { findWorkspaceDir, resolve, resolveRead } from './helpers.js';
import { enrollmentChecks, enrollmentRefusal } from './residencyChecks.js';

/**
 * `musterd residency on|off|status` (ADR 131) — enroll this workspace's seat into harness
 * residency so a directed act can wake it while offline. `on` is the authorization event
 * (admin-authorized server-side): one verb, four writes — the server enrollment row + a
 * **standing** resume grant landed in this workspace's `binding.grant` (so woken sessions occupy
 * via the seat's own credential), a host-scoped bootstrap credential in `binding.host_key` (so the
 * actuator can poll after a claim rewrites `agent_key`, ADR 395), and the machine-local host
 * registry entry (seat → workspace path) that `musterd host` actuates from. `off` reverses all
 * four — the kill switch. `status`
 * cross-checks the three stores and names drift (the `init --check` idiom).
 *
 * The two identities in play are deliberately different flags: `--seat` names *what gets
 * enrolled* (an agent seat; defaults to this workspace's binding), `--as` names *who authorizes*
 * (an admin — enrollment is an actor≠authorizer gate, ADR 127).
 *
 * Increment 5 adds the knobs (ADR 131 §3): `on` takes per-seat override flags, `policy` reads or
 * sets the team-wide defaults with the same flag vocabulary, and `status` renders the effective
 * policy per seat (overridden knobs starred). There is deliberately no `--lane off`: an enrollment
 * that can never wake is a contradiction — "stop waking this seat" is `residency off`.
 */
const POLICY_FLAGS_USAGE =
  '[--lane both|interrupt|batched] [--cooldown <15m>] [--hourly-cap <n>] [--attempt-cap <n>] ' +
  '[--tool-policy reply-only|seat-policy] [--timeout <5m>] [--work-timeout <30m>] ' +
  '[--flow manual|auto] [--convene-huddles on|off] [--idle-wake on|off] [--max-turns <n>] ' +
  '[--budget <usd>] ' +
  '[--transcript-max <MiB, fractions OK>] [--dream on|off] [--dream-nightly <1-3>] ' +
  '[--dream-budget <usd>]';

/**
 * The remediation every drift line points at. It carries `--as <admin>` because enrollment is an
 * actor≠authorizer gate (ADR 127, and the header above) and these hints are read *inside a seat's
 * workspace*, where the caller authenticates as that agent seat — so the bare form fails with
 * `this operation requires an admin seat (is_admin)`. Observed 2026-07-31: the drift line printed
 * the bare form, the operator ran it verbatim in the workspace it named, and it was refused. A hint
 * that cannot be executed where it is printed is worse than no hint — it reads as a broken tool
 * rather than a missing flag. One constant so the whole surface cannot drift apart again.
 */
const ENROLL_HINT = 'musterd residency on --as <admin>';

/**
 * The enrollment↔registry cross-check (ADR 131 §1, third store): every enrollment claiming a host
 * label this machine has answered to needs a registry entry whose workspace can actually host a
 * woken session, or `musterd host` will be handed an order it cannot serve.
 *
 * Pure — takes the three inputs and returns the lines — so the wording is testable. That matters
 * more than it looks: these strings ARE the remediation, and both faults they distinguish have now
 * been hit for real on the dogfood machine. `existsSync` is injectable for the same reason.
 */
/** Harness class → its binary resolver (ADR 221). Unlisted classes are not checked. */
const HARNESS_BIN_RESOLVERS: Record<string, () => Promise<string | null>> = {
  'claude-code': resolveClaudeBin,
  codex: resolveCodexBin,
};

/**
 * ADR 221 — can this machine actually spawn what it is enrolled to spawn?
 *
 * A host missing its harness binary now DEFERS every wake rather than failing it, which stops the
 * act being retired as `wake_exhausted` for a fault local to the machine. The cost of that trade is
 * silence: the act waits instead of dying, and waits indefinitely if nobody notices. This line is
 * what converts that wait back into something an operator can see and fix — so it names the seat,
 * the harness, and the consequence, not just "missing".
 *
 * Scoped to enrollments whose host is THIS machine: another host's unresolvable harness is not this
 * reader's problem, and warning about it would train them to skip the line.
 */
export function harnessDrift(
  residency: readonly Pick<Residency, 'seat' | 'host' | 'harness'>[],
  hostLabel: string,
  resolvable: (harness: string) => boolean,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of residency) {
    if (r.host !== hostLabel) continue;
    if (seen.has(r.harness)) continue;
    if (resolvable(r.harness)) continue;
    seen.add(r.harness);
    const sharing = residency
      .filter((o) => o.host === hostLabel && o.harness === r.harness)
      .map((o) => `"${o.seat}"`);
    lines.push(
      `! cannot actuate: ${sharing.join(', ')} enrolled here for harness "${r.harness}", but no ` +
        `${r.harness} binary resolves on this host — every wake DEFERS (never fails, so no attempt ` +
        `is spent), and the act waits until this is fixed. Install it on the host's PATH, or ` +
        `re-enroll the seat to a machine that has it.`,
    );
  }
  return lines;
}

export function registryDrift(
  residency: readonly Pick<Residency, 'seat' | 'host'>[],
  entries: readonly HostRegistryEntry[],
  team: string,
  hostLabel: string,
  exists: (p: string) => boolean = existsSync,
  /**
   * Seats the roster says live on ANOTHER node (ADR 503 `residence`, a node id, never a hostname).
   * Skipped whatever their host label says: two Macs both answer `mac.lan`, so on the hub every
   * joiner seat matched this machine's label and read as drift, with a remedy that would re-home it
   * (second-machine run 2026-10-03, finding 2; lane 01M41NQ05V).
   */
  boundElsewhere: ReadonlySet<string> = new Set(),
): string[] {
  const myLabels = new Set([hostLabel, ...entries.map((e) => e.host)]);
  const lines: string[] = [];
  for (const r of residency) {
    if (!myLabels.has(r.host) || boundElsewhere.has(r.seat)) continue;
    const entry = entries.find((e) => e.team === team && e.seat === r.seat);
    if (!entry) {
      lines.push(
        `! drift: "${r.seat}" is enrolled to ${r.host} but missing from this machine's host ` +
          `registry — run \`${ENROLL_HINT}\` in its workspace`,
      );
      continue;
    }
    if (exists(join(entry.workspace, BINDING_DIR, BINDING_FILE))) continue;
    // Two faults, two different next moves, so they get two different sentences. A workspace that is
    // GONE is nearly always an abandoned worktree the registry outlived — the fix is to re-register
    // the real one. Saying "has no binding" about a path that does not exist sends the reader
    // hunting a config fault instead of recognising their own deleted directory. A workspace that
    // exists but holds no binding is the provisioning case the original text was written for.
    const vanished = !exists(entry.workspace);
    lines.push(
      `! drift: "${r.seat}"'s registered workspace ${entry.workspace} ` +
        (vanished ? 'no longer exists' : 'has no binding') +
        ` — a wake cannot occupy; re-run \`${ENROLL_HINT}\` in ` +
        (vanished ? "the seat's real workspace" : 'that workspace'),
    );
  }
  return lines;
}

/**
 * The actuator credential (ADR 395): reuse `binding.host_key` when present, otherwise mint a
 * host-scoped bootstrap credential for this host label. Claim paths never see this field.
 */
export async function ensureHostKey(
  binding: Binding,
  host: string,
  mint: (host: string) => Promise<string>,
): Promise<string> {
  if (binding.host_key) return binding.host_key;
  return mint(host);
}

/**
 * The flags `musterd residency` takes (lane
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
/**
 * The flags `musterd residency` takes (lane
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
export const RESIDENCY_FLAGS = [
  '--help',
  '--version',
  '-c',
  'abort',
  'attempt-cap',
  'branch',
  'budget',
  'claude',
  'client',
  'cloud-provision',
  'codex',
  'convene-huddles',
  'cooldown',
  'credential',
  'data',
  'dream',
  'dream-budget',
  'dream-nightly',
  'enroll',
  'error',
  'exec',
  'exit',
  'flow',
  'git',
  'harness',
  'host',
  'hourly-cap',
  'idle-wake',
  'ignore',
  'interval',
  'key-env',
  'lane',
  'leases',
  'local-session-live',
  'log',
  'ls-files',
  'max-turns',
  'musterd-host',
  'no-gateway',
  'opencode',
  'origin',
  'pipe',
  'remote',
  'residency',
  'rev-parse',
  'run',
  'seat',
  'security',
  'session',
  'sponsor',
  'timeout',
  'tool-policy',
  'transcript-max',
  'utf8',
  'work-timeout',
  'workspace',
] as const;

export async function residencyCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...RESIDENCY_FLAGS],
    'the flags `musterd residency` takes are listed by `musterd help residency`',
  );
  const sub = parsed.positionals[0];
  if (sub === 'on') return onCommand(parsed);
  if (sub === 'off') return offCommand(parsed);
  if (sub === 'policy') return policyCommand(parsed);
  if (sub === 'status' || sub === undefined) return statusCommand(parsed);
  throw new CliError(
    'usage: musterd residency on | off | status | policy  ' +
      '(--seat <agent> = what gets enrolled, default this workspace’s seat; --as <admin> = who ' +
      `authorizes; --harness musterd --key-env <VAR> = a resident seat on your own key, ADR 588). ` +
      `Knobs, on \`on\` (this seat) or \`policy\` (team defaults): ${POLICY_FLAGS_USAGE}`,
    2,
  );
}

/**
 * Collect the knob flags into a sparse policy object — only explicitly-passed flags enter it, so
 * an enroll without knob flags preserves any existing override (`undefined`), and `--reset-policy`
 * clears back to team defaults (`{}`). Ranges are enforced server-side (the 400 names the range);
 * here we only refuse shapes that cannot travel (non-numbers, malformed durations).
 */
export function collectPolicyFlags(parsed: Parsed): ResidencyPolicyOverride | undefined {
  const out: Record<string, unknown> = {};
  const num = (flag: string, key: string, scale = 1) => {
    const raw = flagStr(parsed.flags, flag);
    if (raw === undefined) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CliError(`--${flag} wants a number (got "${raw}")`, 2);
    out[key] = Math.round(n * scale);
  };
  const lane = flagStr(parsed.flags, 'lane');
  if (lane !== undefined) out['lane'] = lane;
  const cooldown = flagStr(parsed.flags, 'cooldown');
  if (cooldown !== undefined) out['cooldown_ms'] = parseDurationMs(cooldown, '--cooldown');
  num('hourly-cap', 'hourly_cap');
  num('attempt-cap', 'attempt_cap');
  const toolPolicy = flagStr(parsed.flags, 'tool-policy');
  if (toolPolicy !== undefined) out['tool_policy'] = toolPolicy;
  const timeout = flagStr(parsed.flags, 'timeout');
  if (timeout !== undefined) out['timeout_ms'] = parseDurationMs(timeout, '--timeout');
  const workTimeout = flagStr(parsed.flags, 'work-timeout');
  if (workTimeout !== undefined)
    out['work_timeout_ms'] = parseDurationMs(workTimeout, '--work-timeout');
  const flow = flagStr(parsed.flags, 'flow');
  if (flow !== undefined) {
    if (flow !== 'manual' && flow !== 'auto')
      throw new CliError(`--flow wants manual|auto (got "${flow}")`, 2);
    out['flow'] = flow;
  }
  // ADR 386: does opening a huddle wake the seats it names? The daemon has read this
  // knob since it shipped; until this flag no surface could set it.
  const convene = flagStr(parsed.flags, 'convene-huddles');
  if (convene !== undefined) {
    if (convene !== 'on' && convene !== 'off')
      throw new CliError(`--convene-huddles wants on|off (got "${convene}")`, 2);
    out['convene_huddles'] = convene === 'on';
  }
  // ADR 558: may an idle open session be pushed a turn? `policy` sets the team default,
  // `on <seat>` the seat's override — the same flag parser serves both.
  const idleWake = flagStr(parsed.flags, 'idle-wake');
  if (idleWake !== undefined) {
    if (idleWake !== 'on' && idleWake !== 'off')
      throw new CliError(`--idle-wake wants on|off (got "${idleWake}")`, 2);
    out['idle_wake'] = idleWake === 'on';
  }
  num('max-turns', 'max_turns');
  const budget = flagStr(parsed.flags, 'budget');
  if (budget !== undefined) {
    const n = Number(budget);
    if (!Number.isFinite(n)) throw new CliError(`--budget wants dollars (got "${budget}")`, 2);
    out['budget_usd'] = n;
  }
  num('transcript-max', 'transcript_max_bytes', 1_048_576); // MiB → bytes
  // ADR 494: may an idle seat dream outside working hours, how often a night, at what ceiling.
  const dream = flagStr(parsed.flags, 'dream');
  if (dream !== undefined) {
    if (dream !== 'on' && dream !== 'off')
      throw new CliError(`--dream wants on|off (got "${dream}")`, 2);
    out['dream_enabled'] = dream === 'on';
  }
  num('dream-nightly', 'dream_nightly_wakes');
  const dreamBudget = flagStr(parsed.flags, 'dream-budget');
  if (dreamBudget !== undefined) {
    const n = Number(dreamBudget);
    if (!Number.isFinite(n))
      throw new CliError(`--dream-budget wants dollars (got "${dreamBudget}")`, 2);
    out['dream_budget_usd'] = n;
  }
  if (parsed.flags['reset-policy'] === true) {
    if (Object.keys(out).length > 0)
      throw new CliError('--reset-policy clears every knob — drop the other policy flags', 2);
    return {};
  }
  return Object.keys(out).length > 0 ? (out as ResidencyPolicyOverride) : undefined;
}

/**
 * The inverse of {@link collectPolicyFlags}: a sparse override as the `residency on` knob flags that
 * re-create it. `move --to` prints it, because the wake enrollment the hub hands back reaches the
 * machine that ran the move, not the target that re-enrolls it (ADR 703).
 */
export function policyFlags(policy: ResidencyPolicyOverride): string[] {
  const dur = (ms: number) => (ms % 1_000 === 0 ? fmtDurationMs(ms) : `${Math.round(ms / 1_000)}s`);
  const onOff = (b: boolean) => (b ? 'on' : 'off');
  const out: string[] = [];
  const add = (flag: string, value: string | undefined) => {
    if (value !== undefined) out.push(`--${flag}`, value);
  };
  add('lane', policy.lane);
  add('cooldown', policy.cooldown_ms === undefined ? undefined : dur(policy.cooldown_ms));
  add('hourly-cap', policy.hourly_cap?.toString());
  add('attempt-cap', policy.attempt_cap?.toString());
  add('tool-policy', policy.tool_policy);
  add('timeout', policy.timeout_ms === undefined ? undefined : dur(policy.timeout_ms));
  add(
    'work-timeout',
    policy.work_timeout_ms === undefined ? undefined : dur(policy.work_timeout_ms),
  );
  add('flow', policy.flow);
  add(
    'convene-huddles',
    policy.convene_huddles === undefined ? undefined : onOff(policy.convene_huddles),
  );
  add('idle-wake', policy.idle_wake === undefined ? undefined : onOff(policy.idle_wake));
  add('max-turns', policy.max_turns?.toString());
  add('budget', policy.budget_usd?.toString());
  add(
    'transcript-max',
    policy.transcript_max_bytes === undefined
      ? undefined
      : String(policy.transcript_max_bytes / 1_048_576),
  );
  add('dream', policy.dream_enabled === undefined ? undefined : onOff(policy.dream_enabled));
  add('dream-nightly', policy.dream_nightly_wakes?.toString());
  add('dream-budget', policy.dream_budget_usd?.toString());
  return out;
}

/** One-line policy summary. With `override`, starred knobs are the seat-overridden ones. */
export function renderPolicy(
  policy: ResidencyPolicy,
  override?: ResidencyPolicyOverride | null,
): string {
  const star = (key: keyof ResidencyPolicy) => (override && override[key] !== undefined ? '*' : '');
  const bits = [
    `lane ${policy.lane}${star('lane')}`,
    `cooldown ${fmtDurationMs(policy.cooldown_ms)}${star('cooldown_ms')}`,
    `${policy.hourly_cap}/h${star('hourly_cap')}`,
    `${policy.attempt_cap} attempts${star('attempt_cap')}`,
    `${policy.tool_policy}${star('tool_policy')}`,
    `timeout ${fmtDurationMs(policy.timeout_ms)}${star('timeout_ms')}`,
    `work-timeout ${fmtDurationMs(policy.work_timeout_ms)}${star('work_timeout_ms')}`,
    `flow ${policy.flow}${star('flow')}`,
  ];
  if (policy.convene_huddles) bits.push(`convenes huddles${star('convene_huddles')}`);
  else if (override && override.convene_huddles === false) bits.push('refuses huddle convene*');
  if (!policy.idle_wake) bits.push(`idle wake off${star('idle_wake')}`);
  if (policy.dream_enabled) {
    const ceiling =
      policy.dream_budget_usd !== undefined
        ? ` ≤$${policy.dream_budget_usd}${star('dream_budget_usd')}`
        : '';
    bits.push(
      `dreams ${policy.dream_nightly_wakes}/night${star('dream_enabled') || star('dream_nightly_wakes')}${ceiling}`,
    );
  }
  if (policy.max_turns !== undefined) bits.push(`${policy.max_turns} turns${star('max_turns')}`);
  if (policy.budget_usd !== undefined)
    bits.push(`budget $${policy.budget_usd}${star('budget_usd')}`);
  bits.push(`transcript ${fmtBytes(policy.transcript_max_bytes)}${star('transcript_max_bytes')}`);
  return bits.join(' · ');
}

/** Launch defaults ⊕ team defaults ⊕ seat override — the CLI-side twin of the server's
 *  `effectiveWakePolicy`. Generic over density: the same merge layers an override onto dense defaults
 *  (for rendering) and onto the sparse stored doc (for the ADR 185 read-merge-write). */
function mergePolicy<T extends ResidencyPolicy | ResidencyPolicyOverride>(
  defaults: T,
  override: ResidencyPolicyOverride | null | undefined,
): T {
  if (!override) return defaults;
  const merged: T = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * The agent seat's folder — where the standing grant, host key and host-registry entry land.
 * `--workspace <dir>` names it; otherwise it is the current folder, as before.
 *
 * Why the flag exists (ADR 442): enrollment is admin-authorized, and it used to run from the AGENT's
 * folder with `--as <admin>`. `--as` is gone — a folder acts only as its own member — so the admin now
 * runs `residency on --seat <agent> --workspace <agent's folder>` from their OWN Workspace. The admin's
 * identity never enters the agent's folder; only the grant the daemon issued for that seat does.
 */
export function seatWorkspace(parsed: Parsed): { dir: string; binding: Binding | null } | null {
  const named = flagStr(parsed.flags, 'workspace');
  if (named) {
    const binding = findBinding(named);
    if (!binding) {
      throw new CliError(
        `no musterd binding at ${named} — --workspace must be the agent seat's own folder`,
        2,
      );
    }
    return { dir: findWorkspaceDir(named) ?? named, binding };
  }
  const dir = findWorkspaceDir();
  return dir ? { dir, binding: findBinding() } : null;
}

/** The seat this invocation is about: `--seat` wins, else the seat folder's fixed seat. */
function resolveSeat(parsed: Parsed): string {
  const flag = flagStr(parsed.flags, 'seat');
  if (flag) return flag;
  const binding = seatWorkspace(parsed)?.binding ?? null;
  const bound = binding ? bindingSeat(binding) : undefined;
  if (bound) return bound;
  throw new CliError(
    'no seat to enroll — name it with --seat <agent> --workspace <its folder>, run from an ' +
      'admin’s own Workspace (ADR 442: the folder you run from is who authorizes).',
    2,
  );
}

/**
 * `residency on`, callable with the knobs already in hand: ADR 696's `musterd move` re-enrolls a
 * moved seat with the override the hub returned, not with flags a person retyped.
 */
export async function residencyOn(
  parsed: Parsed,
  opts: { policy?: ResidencyPolicyOverride } = {},
): Promise<number> {
  return onCommand(parsed, opts);
}

async function onCommand(
  parsed: Parsed,
  opts: { policy?: ResidencyPolicyOverride } = {},
): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const seat = resolveSeat(parsed);
  const target = seatWorkspace(parsed);
  const binding = target?.binding ?? null;
  // Identity declares no surface since ADR 281; the captured session's harness is the evidence-backed
  // default (a claude-code hook only fires under claude-code). `--harness` stays the explicit choice.
  const harness = flagStr(parsed.flags, 'harness') ?? binding?.session?.harness;
  if (!harness) {
    throw new CliError('no harness — pass --harness <class> (e.g. claude-code)', 2);
  }
  if (harness === 'codex') {
    const capability = await codexCapability();
    if (!capability.supported) {
      throw new CliError(
        `Codex can coordinate manually but cannot enroll for daemon wake: ${capability.reason}`,
        2,
      );
    }
  }
  if (harness === 'opencode') {
    const capability = await opencodeCapability();
    if (!capability.supported) {
      throw new CliError(
        `OpenCode can coordinate manually but cannot enroll for daemon wake: ${capability.reason}`,
        2,
      );
    }
  }
  // ADR 588 §1: a resident seat runs on the operator's own key, named by its environment variable.
  // Only the NAME is taken and stored (host registry); the value is read by `musterd host` at
  // spawn, never here, never in any file.
  const keyEnv = flagStr(parsed.flags, 'key-env');
  if (harness === 'musterd') {
    if (!keyEnv) {
      throw new CliError(
        '--harness musterd needs --key-env <VAR>: the environment variable holding the API key the ' +
          'resident seat runs on (e.g. ANTHROPIC_API_KEY) — the name, never the key (ADR 588)',
        2,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv) || /^(sk-|xai-|mskey_|msgr_|mscr_)/.test(keyEnv)) {
      throw new CliError(
        `--key-env takes a variable NAME (like ANTHROPIC_API_KEY), not a value — nothing was stored`,
        2,
      );
    }
  } else if (keyEnv) {
    throw new CliError('--key-env applies only to --harness musterd (ADR 588)', 2);
  }
  const host = flagStr(parsed.flags, 'host') ?? hostname();
  const policy = opts.policy ?? collectPolicyFlags(parsed);

  // ADR 645 §4.2: verify the four things this host must hold BEFORE the row is written, so an
  // enrollment never promises a wake the machine cannot serve. Only when the host being enrolled is
  // this machine: another machine's binaries, logins and folders cannot be probed from here.
  const thisMachine = host === hostname();
  if (thisMachine) {
    const checks = await enrollmentChecks({
      seat,
      harness,
      dir: target?.dir ?? null,
      keyEnv,
      model: binding?.model ?? process.env['MUSTERD_MODEL'],
    });
    const refusal = enrollmentRefusal(checks, seat);
    if (refusal) throw new CliError(refusal, 2);
    if (!parsed.flags['json']) {
      for (const c of checks) {
        process.stdout.write(theme.meta(`  ${sym.ok} ${c.name}: ${c.detail}`) + '\n');
      }
    }
  } else if (!parsed.flags['json']) {
    process.stdout.write(
      theme.warn(
        `  ! --host ${host} is not this machine (${hostname()}): the ADR 645 enrollment checks ` +
          `(harness, login, binding, workspace) were not run — run \`residency on\` there to verify`,
      ) + '\n',
    );
  }

  const res = await http.enrollResidency(team, {
    seat,
    harness,
    host,
    ...(policy !== undefined ? { policy } : {}),
  });

  // Land the standing grant in this workspace's binding so woken sessions occupy via the seat's
  // own credential (the daemon never holds it) — only when this folder is actually the seat's.
  // The same condition gates the host-registry write: seat → workspace is a fact only the seat's
  // own workspace can assert (ADR 131 §2's third store).
  const dir = target?.dir ?? null;
  let grantSaved = false;
  let registered = false;
  let hostKeyMinted = false;
  if (dir && binding && bindingSeat(binding) === seat) {
    let hostKey = binding.host_key;
    try {
      hostKey = await ensureHostKey(binding, res.residency.host, async (label) => {
        const minted = await http.mintBootstrapCredential(team, {
          use: 'host',
          target: label,
          label: `residency:${label}`,
        });
        return minted.agent_key;
      });
      hostKeyMinted = hostKey !== binding.host_key;
    } catch (err) {
      process.stdout.write(
        theme.warn(
          `  ! could not mint a host-scoped wake credential — the actuator keeps using ` +
            `binding.agent_key until the next residency on (${(err as Error).message})`,
        ) + '\n',
      );
    }
    saveBinding(dir, {
      ...binding,
      grant: res.grant,
      ...(hostKey !== undefined ? { host_key: hostKey } : {}),
    });
    grantSaved = true;
    upsertHostEntry({
      server: binding.server,
      team,
      seat,
      workspace: dir,
      harness: res.residency.harness,
      host: res.residency.host,
      ...(keyEnv !== undefined ? { key_env: keyEnv } : {}),
    });
    registered = true;
  }

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ residency: res.residency, grant_saved: grantSaved, registered }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(
      `${theme.memberName(seat, 'agent')} is enrolled — offline reads ${theme.accent('offline · wakeable')}`,
    ) + '\n',
  );
  process.stdout.write(
    theme.meta(`  harness ${res.residency.harness} · host ${res.residency.host}`) + '\n',
  );
  if (keyEnv !== undefined) {
    process.stdout.write(
      theme.meta(
        `  key env ${keyEnv} — read by \`musterd host\` at spawn (else Keychain ${seatKeyService(keyEnv)}), never stored`,
      ) + '\n',
    );
    if (!process.env[keyEnv] && !(await keychainLookup(seatKeyService(keyEnv)))) {
      process.stdout.write(
        theme.warn(
          `  ! ${keyEnv} is unset in this shell and there is no Keychain item — every wake of "${seat}" defers. ` +
            `Keep the key out of the user-wide environment (ADR 605): ` +
            `security add-generic-password -s ${seatKeyService(keyEnv)} -a musterd -w`,
        ) + '\n',
      );
    }
    if (!(binding?.model ?? process.env['MUSTERD_MODEL'])) {
      process.stdout.write(
        theme.warn(
          '  ! no model declared (binding.model or MUSTERD_MODEL) — a native wake never defaults one (ADR 101) and will defer',
        ) + '\n',
      );
    }
  }
  // ADR 591: an enrolled seat the hub cannot resolve holds the whole team's lane traffic from this
  // machine — say so here, on the command that makes the seat wakeable, with the one fix.
  const reach = seatReachLines(seat, loadConfig().rosterHome[team], 'agent');
  if (reach) {
    process.stdout.write(
      theme.warn(`  ! ${reach[0]}`) + '\n' + theme.meta(`    ${reach[1]}`) + '\n',
    );
  }
  if (res.residency.policy && Object.keys(res.residency.policy).length > 0) {
    process.stdout.write(
      theme.meta(`  seat overrides: ${JSON.stringify(res.residency.policy)}`) + '\n',
    );
  } else if (policy !== undefined && Object.keys(policy).length === 0) {
    process.stdout.write(theme.meta('  seat overrides cleared — team defaults govern') + '\n');
  }
  // Grant-rotation trap (dogfood 2026-07-13): re-enrolling rotates the standing grant while a
  // live session still holds the old one in its adapter — say so, or the next daemon bounce
  // surprises with "grant revoked".
  if (res.seat_live) {
    process.stdout.write(
      theme.warn(
        `  ! "${seat}" has a live session — it occupies via the grant this enroll just rotated; ` +
          'the new grant and policy govern from its next wake/claim (a reconnect may need team_join)',
      ) + '\n',
    );
  }
  // ADR 434 §c: a fresh enrollment says "from now". Name what it will not wake for, once, here —
  // the alternative was gptbot draining twenty July acts one paid wake at a time (2026-09-21).
  if (res.predating_backlog !== undefined && res.predating_backlog > 0) {
    process.stdout.write(
      theme.warn(
        `  ! ${res.predating_backlog} act(s) owed to "${seat}" predate this enrollment and will not wake it — ` +
          're-send (steer / handoff) what still matters, or answer them',
      ) + '\n',
    );
  }
  if (grantSaved) {
    process.stdout.write(
      theme.meta('  standing grant saved to .musterd/binding.json (revoked by `residency off`)') +
        '\n',
    );
    process.stdout.write(
      theme.meta(`  host registry: ${seat} → ${dir} (\`musterd host\` actuates from it)`) + '\n',
    );
    if (hostKeyMinted) {
      process.stdout.write(
        theme.meta('  host-scoped wake credential saved to .musterd/binding.json (ADR 395)') + '\n',
      );
    }
  } else {
    process.stdout.write(
      theme.warn(
        `  ! standing grant NOT saved locally (no binding for "${seat}" here) — ` +
          'run this in the seat’s workspace so woken sessions can occupy',
      ) + '\n',
    );
    process.stdout.write(
      theme.warn(
        '  ! host registry NOT updated — `musterd host` on this machine cannot wake ' +
          `"${seat}" until \`residency on\` runs in its workspace`,
      ) + '\n',
    );
    process.stdout.write(theme.meta(`  grant: ${res.grant}`) + '\n');
  }
  return 0;
}

async function offCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const seat = resolveSeat(parsed);
  await http.revokeResidency(team, seat);

  // The server grant is revoked; drop the now-dead token from the local binding too, and take the
  // seat out of this machine's host registry — after the kill switch, `musterd host` must derive
  // *and* hold nothing for it.
  const target = seatWorkspace(parsed);
  const dir = target?.dir ?? null;
  const binding = target?.binding ?? null;
  if (
    dir &&
    binding &&
    bindingSeat(binding) === seat &&
    (binding.grant !== undefined || binding.host_key !== undefined)
  ) {
    const { grant: _dead, host_key: _host, ...rest } = binding;
    saveBinding(dir, rest, { drop: { host_key: true } });
  }
  removeHostEntry({ ...(binding ? { server: binding.server } : {}), team, seat });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ok: true, seat }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`${theme.memberName(seat, 'agent')} is unenrolled — the standing grant is revoked`) +
      '\n',
  );
  return 0;
}

/**
 * `musterd residency policy` — the team-wide wake-policy defaults, same flag vocabulary as `on`
 * (one mental model: `policy` sets the team, `on` overrides one seat). No knob flags = print the
 * current defaults. Sets go read → merge → POST so one knob changes without re-stating the rest;
 * the server re-parses with defaults and audits `policy.change` (admin, ADR 127).
 */
async function policyCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const knobs = collectPolicyFlags(parsed);
  const { policy: current, stored } = await http.getPolicy(team);

  if (knobs === undefined) {
    if (parsed.flags['json']) {
      process.stdout.write(
        JSON.stringify({ ...current.residency, stored: stored.residency ?? {} }) + '\n',
      );
      return 0;
    }
    process.stdout.write(`${theme.accent('wake policy defaults')} — ${team}\n`);
    process.stdout.write(`  ${renderPolicy(current.residency)}\n`);
    // ADR 185: which of those values this team actually chose, and which track the shipped default
    // and will move when it does. The old dense storage made every value look chosen.
    const chosen = Object.keys(stored.residency ?? {});
    process.stdout.write(
      theme.meta(
        chosen.length === 0
          ? '  every value inherited — a shipped default change reaches this team'
          : `  set on this team: ${chosen.join(', ')} — the rest inherit`,
      ) + '\n',
    );
    process.stdout.write(
      theme.meta('  set: musterd residency policy --cooldown 15m …  ' + POLICY_FLAGS_USAGE) + '\n',
    );
    return 0;
  }

  // ADR 185: merge into the SPARSE stored residency, so setting one knob pins one knob. `--reset-policy`
  // drops the key entirely — which is what "back to launch defaults" always meant, and now is.
  const residency =
    Object.keys(knobs).length === 0 ? undefined : mergePolicy(stored.residency ?? {}, knobs);
  const next: PolicyOverride = { ...stored };
  if (residency === undefined) delete next.residency;
  else next.residency = residency;
  const { policy: updated } = await setPolicySigned(http, team, next);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(updated.residency) + '\n');
    return 0;
  }
  process.stdout.write(success(`wake policy defaults updated — ${team}`) + '\n');
  process.stdout.write(`  ${renderPolicy(updated.residency)}\n`);
  return 0;
}

async function statusCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolveRead(parsed.flags, { claimSeatPerRequest: true });
  const { residency, policy_defaults } = await http.residency(team);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ residency, policy_defaults }) + '\n');
    return 0;
  }

  process.stdout.write(`${theme.accent('residency')} — ${team} (${residency.length} enrolled)\n`);
  if (policy_defaults) {
    process.stdout.write(theme.meta(`defaults: ${renderPolicy(policy_defaults)}`) + '\n');
  }
  if (residency.length === 0) {
    process.stdout.write(
      theme.meta(`no seats enrolled — \`${ENROLL_HINT}\` in a seat’s workspace`) + '\n',
    );
    return 0;
  }
  for (const r of residency) {
    process.stdout.write(renderResidency(r) + '\n');
    // Effective policy per seat, seat-overridden knobs starred. Only when something differs from
    // the defaults line above — an all-defaults seat stays one line.
    if (r.policy && Object.keys(r.policy).length > 0 && policy_defaults) {
      process.stdout.write(
        theme.meta(
          `    policy: ${renderPolicy(mergePolicy(policy_defaults, r.policy), r.policy)}`,
        ) + '\n',
      );
    }
  }

  // Cross-check the local workspace's stores against the server row (the `init --check` idiom).
  const binding = findBinding();
  const bound = binding ? bindingSeat(binding) : undefined;
  if (binding && bound) {
    const mine = residency.find((r) => r.seat === bound);
    if (mine && binding.grant === undefined) {
      process.stdout.write(
        theme.warn(
          `! drift: "${bound}" is enrolled but this workspace holds no grant — ` +
            `re-run \`${ENROLL_HINT}\` here`,
        ) + '\n',
      );
    } else if (!mine && binding.grant !== undefined) {
      process.stdout.write(
        theme.meta(
          `note: this workspace holds a grant but "${bound}" is not enrolled ` +
            '(an ADR 087 resume grant, or a stale residency token)',
        ) + '\n',
      );
    }
    if (mine && mine.host !== hostname()) {
      process.stdout.write(
        theme.warn(
          `! "${bound}" is enrolled to host ${mine.host} — this machine (${hostname()}) is not its actuator`,
        ) + '\n',
      );
    }
  }

  // Third store (ADR 131 §1): the machine-local host registry. Every enrollment claiming a host
  // label this machine has answered to must have a registry entry, or `musterd host` here will be
  // handed a wake order it cannot map to a workspace.
  const registry = loadHostRegistry();
  // ADR 221: resolve each harness this machine is enrolled for, once, and report the ones it
  // cannot spawn. Resolution is async and a miss is uncached by design (installing the CLI while
  // the host runs must become visible), so it is done here and handed to the pure check as a map.
  const myHarnesses = [
    ...new Set(residency.filter((r) => r.host === hostname()).map((r) => r.harness)),
  ];
  const resolved = new Map<string, boolean>();
  for (const h of myHarnesses) {
    const resolver = HARNESS_BIN_RESOLVERS[h];
    // An unknown harness class is not a fault to report — backends are pluggable (ADR 131 §7) and
    // this machine simply may not be its actuator. Silence beats a wrong accusation.
    resolved.set(h, resolver === undefined ? true : (await resolver()) !== null);
  }
  for (const line of harnessDrift(residency, hostname(), (h) => resolved.get(h) !== false)) {
    process.stdout.write(theme.warn(line) + '\n');
  }

  // Seats whose residence the roster binds to another node than the answering daemon's own. The
  // roster read is best-effort: an older daemon without `node`/`residence` skips nothing.
  const boundElsewhere = new Set<string>();
  try {
    const roster = await http.roster(team);
    const here = roster.node?.id;
    if (here) {
      for (const m of roster.members) {
        const r = m.residence;
        if (r && (r.kind === 'cloud' || r.node !== here)) boundElsewhere.add(m.name);
      }
    }
  } catch {
    /* the check degrades to host labels alone, as before */
  }
  for (const line of registryDrift(
    residency,
    registry.entries,
    team,
    hostname(),
    existsSync,
    boundElsewhere,
  )) {
    process.stdout.write(theme.warn(line) + '\n');
  }
  for (const entry of registry.entries.filter((e) => e.team === team)) {
    if (!residency.some((r) => r.seat === entry.seat)) {
      process.stdout.write(
        theme.meta(
          `note: host registry holds "${entry.seat}" (${hostRegistryPath()}) but the seat is not ` +
            `enrolled — stale after a revoke elsewhere; \`${ENROLL_HINT}\` or ignore`,
        ) + '\n',
      );
    }
  }
  return 0;
}

function renderResidency(r: Residency): string {
  const since = theme.meta(clock(r.updated_at));
  const authorized = r.authorized_by
    ? theme.meta(`authorized by ${r.authorized_by}`)
    : theme.meta('—');
  return `${since} ${theme.memberName(r.seat, 'agent')} ${theme.meta(`[${r.harness}]`)} ${sym.dot} host ${r.host} ${sym.dot} ${authorized}`;
}
