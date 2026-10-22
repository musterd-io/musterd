import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostProvision } from '@musterd/protocol';
import type { HttpClient } from '../client.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import type { Harness } from '../onboard/harness.js';
import { harnessAdapters } from '../onboard/harnesses/index.js';
import { provisionSeat } from '../onboard/provisionSeat.js';
import { provisionWorkspace } from '../onboard/workspace.js';
import { loadHostRegistry, upsertHostEntry } from './registry.js';

/**
 * The sponsor host's provisioner (ADR 463 §3): each tick, claim the provisions this host key may
 * serve, and stand each agent up on this machine — a Workspace, the seat's credential and binding,
 * residency enrollment, the registry entry that makes the wake loop poll for it — then report
 * `ready`, or `failed` naming the step that broke. The daemon's first wake (`provisioned`) does the
 * rest: the new agent greets its sponsor.
 *
 * Two identities, deliberately. The CLAIM and REPORT ride the host key (a credential scoped to this
 * host label and to the seats its sponsor may serve). Everything that acts AS the sponsor — the
 * seat's credential, its grant, its enrollment — rides the sponsor's own binding, exactly as
 * `musterd agent` and `musterd residency on` would if the sponsor ran them by hand. The host is
 * infrastructure; it never decides work (ADR 131 §7) and it never holds more than the sponsor does.
 */

/** The steps a provision can fail at — the reason a report carries, and what the sponsor is told. */
export type ProvisionStep = 'workspace' | 'credential' | 'enroll' | 'unexpected';

export interface ProvisionDeps {
  /** Host-key auth: claim and report. */
  client: Pick<HttpClient, 'claimProvisions' | 'reportProvision'>;
  /** The sponsor's own identity: mint the seat's credential and grant, enroll its residency. */
  sponsor: Pick<
    HttpClient,
    'mintBootstrapCredential' | 'issueGrant' | 'enrollResidency' | 'revokeBootstrapCredential'
  >;
  team: string;
  server: string;
  /** This host's label — the one the daemon's provision rows and residency enrollments name. */
  host: string;
  /** The host key, copied into each seat's binding so the wake loop can poll for it (ADR 395). */
  hostKey: string;
  harness: Harness;
  /** The host's own checkout: the worktree (or clone) source. */
  repoRoot: string;
  /** `--clone`: a full clone instead of a `git worktree`, for isolation from the sponsor's checkout. */
  clone: boolean;
  /** ADR 675: the clone's `origin` URL — the cloud host passes its mirror's own remote so the seat
   *  pushes to GitHub, not into the mirror. Absent on a sponsor's own machine (git's default). */
  origin?: string;
  log: (line: string) => void;
  /**
   * ADR 648: the environment variable holding the model key a resident (`musterd` harness)
   * seat runs on — recorded as the registry entry's `key_env` (the NAME, never the value,
   * ADR 588). Without it a provisioned resident seat enrols but cannot run.
   */
  keyEnv?: string;
  /**
   * ADR 689 d7: rows claimed here whose provisioning the daemon refused `hub_unreachable` — on a
   * joiner, the freshness window lapsed between claim and mint. Held by the caller across ticks
   * (the loop is one process) and retried first on every tick; the daemon's sweep fails a row
   * nobody ever reports on, so a joiner cut off for good still settles.
   */
  deferred?: HostProvision[];
  // ── injectables (tests) ──
  provisionWorkspace?: typeof provisionWorkspace;
  provisionSeat?: typeof provisionSeat;
  upsertHostEntry?: typeof upsertHostEntry;
  loadRegistry?: typeof loadHostRegistry;
  existsSync?: typeof fsExistsSync;
  readBinding?: typeof findBinding;
  writeBinding?: typeof saveBinding;
  /**
   * ADR 703: the workspace half of a `move` row, when a test does not want `provisionSeat`.
   * Returns the workspace directory. Absent, the row is stood up the same way a mint is, with
   * the row's harness instead of this host's.
   */
  arriveMove?: (row: HostProvision) => Promise<string>;
}

export interface ProvisionTick {
  claimed: number;
  ready: number;
  failed: number;
  /** Rows held back this tick on `hub_unreachable` (ADR 689 d7); retried next tick. */
  deferred: number;
}

/** The daemon said "not now, the hub is out of reach" — a wait, never a failed provision. */
function isHubUnreachable(err: unknown): boolean {
  return err instanceof CliError && err.code === 'hub_unreachable';
}

/** A step's failure, tagged with the step so the report names it. */
class StepError extends Error {
  constructor(
    readonly step: ProvisionStep,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * One tick: claim, then for each row stand the agent up and report. Never throws — a failing row
 * is reported `failed` and the next one proceeds; a failing claim is logged and retried next tick.
 */
export async function provisionOnce(deps: ProvisionDeps): Promise<ProvisionTick> {
  const tick: ProvisionTick = { claimed: 0, ready: 0, failed: 0, deferred: 0 };
  // Deferred rows first: they are already ours, and a hub that came back should not wait
  // behind a new claim.
  const retry = deps.deferred ? deps.deferred.splice(0) : [];
  let rows: HostProvision[];
  try {
    rows = (await deps.client.claimProvisions(deps.team, deps.host)).provisions;
  } catch (err) {
    deps.log(`! provision claim failed for ${deps.team}: ${(err as Error).message}`);
    rows = [];
    if (retry.length === 0) return tick;
  }
  for (const row of rows) {
    tick.claimed += 1;
    deps.log(`provision claimed: ${row.agent} (sponsor ${row.sponsor}, ${row.id})`);
  }
  for (const row of [...retry, ...rows]) {
    try {
      await standUp(deps, row);
      await report(deps, row, { state: 'ready' });
      tick.ready += 1;
      deps.log(`provision ready: ${row.agent}`);
    } catch (err) {
      const cause = err instanceof StepError ? err.cause : err;
      if (isHubUnreachable(cause)) {
        tick.deferred += 1;
        deps.deferred?.push(row);
        deps.log(
          `provision deferred for ${row.agent}: the hub is out of reach (${(cause as Error).message}) — retrying next tick`,
        );
        continue;
      }
      const step: ProvisionStep = err instanceof StepError ? err.step : 'unexpected';
      tick.failed += 1;
      deps.log(`! provision FAILED for ${row.agent} at ${step}: ${(err as Error).message}`);
      await report(deps, row, { state: 'failed', reason: step });
    }
  }
  return tick;
}

async function report(
  deps: ProvisionDeps,
  row: HostProvision,
  body: { state: 'ready' } | { state: 'failed'; reason: string },
): Promise<void> {
  try {
    await deps.client.reportProvision(deps.team, row.id, body);
  } catch (err) {
    // The daemon's sweep settles a row nobody reports on (ADR 463 §2) — say so and move on.
    deps.log(`! provision report failed for ${row.agent}: ${(err as Error).message}`);
  }
}

/** The workspace this host already provisioned for `seat`, if its binding still names the seat. */
function alreadyBound(deps: ProvisionDeps, seat: string): string | null {
  const exists = deps.existsSync ?? fsExistsSync;
  const read = deps.readBinding ?? findBinding;
  const entry = (deps.loadRegistry ?? loadHostRegistry)().entries.find(
    (e) => e.team === deps.team && e.seat === seat,
  );
  if (!entry || !exists(join(entry.workspace, '.musterd', 'binding.json'))) return null;
  const binding = read(entry.workspace, {});
  return binding?.claim?.mode === 'seat' && binding.claim.name === seat ? entry.workspace : null;
}

async function standUp(deps: ProvisionDeps, row: HostProvision): Promise<void> {
  const seat = row.agent;
  const moving = row.kind === 'move';
  const spec = moving ? row.move : null;
  if (moving && !spec)
    throw new StepError('enroll', new Error(`move provision ${row.id} names no harness`));
  const harnessId = spec?.harness ?? deps.harness.id;
  if (moving && harnessId === 'musterd' && deps.keyEnv === undefined)
    throw new StepError(
      'enroll',
      new Error(
        `${seat} ran on its own key (ADR 588) — enroll it with musterd residency on --harness musterd --key-env <VAR>`,
      ),
    );
  if (moving && !harnessAdapters().some((a) => a.id === harnessId))
    throw new StepError(
      'enroll',
      new Error(`unknown harness "${harnessId}" on move provision ${row.id}`),
    );
  // A move enrolls the harness the seat had, not the one this host was started with.
  // `musterd` is a resident key, not a workspace harness (ADR 588): the folder is still wired
  // for Claude Code, and enrollment carries `musterd` plus the host's key env.
  const wiringId = moving && harnessId === 'musterd' ? 'claude-code' : harnessId;
  // Review Focus 5: a Workspace already bound to this seat is never provisioned a second time — a
  // re-claimed row (a report that got lost, a sweep that re-queued) goes straight to enrollment,
  // which is idempotent, instead of minting a second credential over a live one.
  let dir = alreadyBound(deps, seat);

  if (dir === null && moving && deps.arriveMove) {
    try {
      dir = await deps.arriveMove(row);
    } catch (err) {
      throw err instanceof StepError ? err : new StepError('workspace', err);
    }
  } else if (dir === null) {
    let workspace;
    try {
      const result = await (deps.provisionSeat ?? provisionSeat)({
        team: deps.team,
        name: seat,
        server: deps.server,
        wiring: { desired: [wiringId], toolkit: '' },
        http: deps.sponsor,
        workspace: () => {
          try {
            return (deps.provisionWorkspace ?? provisionWorkspace)(seat, {
              team: deps.team,
              cwd: deps.repoRoot,
              clone: deps.clone,
              ...(deps.origin !== undefined ? { origin: deps.origin } : {}),
            });
          } catch (err) {
            throw new StepError('workspace', err);
          }
        },
      });
      workspace = result.workspace;
    } catch (err) {
      throw err instanceof StepError ? err : new StepError('credential', err);
    }
    dir = workspace.dir;
  }

  if (moving && harnessId === 'claude-code') {
    try {
      // Lazy: a static import of `commands/move` reads, to cli-flags:check, as this file handing
      // move's flags on. The helper itself takes a directory, not argv.
      const { preAcceptClaudeTrust } = await import('../commands/move.js');
      preAcceptClaudeTrust(dir);
    } catch (err) {
      deps.log(`! could not pre-accept Claude Code's folder trust for ${seat}: ${String(err)}`);
    }
  }

  let res;
  try {
    res = await deps.sponsor.enrollResidency(deps.team, {
      seat,
      harness: harnessId,
      host: deps.host,
      ...(spec?.policy ? { policy: spec.policy } : {}),
    });
  } catch (err) {
    throw new StepError('enroll', err);
  }

  // Enrolling rotates the seat's standing grant, and the wake loop authenticates with a host key,
  // not the claim credential (ADR 395) — so both land in the seat's binding, as `residency on`
  // writes them. Then the registry entry, which is what makes `pollHostOnce` poll for this seat.
  try {
    const binding = (deps.readBinding ?? findBinding)(dir, {});
    if (binding)
      (deps.writeBinding ?? saveBinding)(dir, {
        ...binding,
        grant: res.grant,
        host_key: deps.hostKey,
      });
    (deps.upsertHostEntry ?? upsertHostEntry)({
      server: deps.server,
      team: deps.team,
      seat,
      workspace: dir,
      harness: res.residency.harness,
      host: res.residency.host,
      ...(deps.keyEnv !== undefined ? { key_env: deps.keyEnv } : {}),
    });
  } catch (err) {
    throw new StepError('enroll', err);
  }
}
