import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findBinding, saveBinding } from '../../config.js';
import { resolveMuseBin } from '../../museBin.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, WakeCompletion } from '../backend.js';
import { ensurePinnedMusterd, wakeEnv } from '../pinnedBin.js';
import { holdWakeLease, type WakeLeaseDeps } from '../wakeLeaseFile.js';

const KILL_GRACE_MS = 10_000;
const RESUME_VERIFY_WINDOW_MS = 30_000;

/**
 * Headless runs take the prompt as a positional arg. Approval posture is fixed to
 * `--disable-approval` (sandbox stays on): a wake has no one to answer a prompt, and `--yolo`
 * also drops the sandbox and trusts the workspace — wrong for a daemon-spawned run on a seat's
 * real checkout. `--trust-workspace` loads the project's skills/rules/hooks (the onboard writes
 * them; without it a wake runs blind). `--json` streams JSONL session events; the backend sets
 * `--session-id` itself so the lease and the capture name the run without parsing stdout.
 */
export function buildMuseFreshArgs(
  line: string,
  workspace: string,
  opts: { sessionId: string; maxSteps?: number },
): string[] {
  return [
    'exec',
    '--disable-approval',
    '--trust-workspace',
    '--json',
    ...(opts.maxSteps !== undefined ? ['--max-model-steps', String(opts.maxSteps)] : []),
    '--session-id',
    opts.sessionId,
    line,
  ];
}

export function buildMuseResumeArgs(
  line: string,
  sessionId: string,
  workspace: string,
  opts: { maxSteps?: number },
): string[] {
  return [
    'exec',
    '--disable-approval',
    '--trust-workspace',
    '--json',
    ...(opts.maxSteps !== undefined ? ['--max-model-steps', String(opts.maxSteps)] : []),
    '--session-id',
    sessionId,
    '--allow-workspace-switch',
    line,
  ];
}

export function museWakeEnv(
  base: NodeJS.ProcessEnv,
  leaseId?: string,
  pinnedDir?: string,
  /** ADR 583: the metering gateway's base-URL variables, applied last. */
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'XDG_CONFIG_HOME',
    'MUSTERD_MODEL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key];
  return wakeEnv(env, pinnedDir, leaseId, 'muse', extra);
}

function killTree(child: ChildProcess, graceMs: number): void {
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  kill('SIGTERM');
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
  }, graceMs);
  hard.unref();
}

export interface MuseDeps {
  resolveBin?: () => Promise<string | null>;
  /** Lease-file seams (ADR 546; tests never touch disk). */
  lease?: WakeLeaseDeps;
  spawn?: typeof nodeSpawn;
  readSession?: (workspace: string) => LocalSessionLiveness;
  recordFreshSession?: (workspace: string, id: string, startedAt: number) => void;
  killGraceMs?: number;
  resumeVerifyWindowMs?: number;
  ensurePinned?: (opts: { node: string; binJs: string }) => string | undefined;
  /** Fresh session ids (tests inject; default randomUUID — `exec --session-id` accepts it). */
  newSessionId?: () => string;
}

function recordFreshSession(workspace: string, id: string, startedAt: number): void {
  const binding = findBinding(workspace, {});
  if (!binding) return;
  saveBinding(workspace, {
    ...binding,
    session: { harness: 'muse', id, started_at: startedAt },
  });
}

function capturedId(liveness: LocalSessionLiveness): string | undefined {
  return liveness.state === 'resumable' && liveness.session?.harness === 'muse'
    ? liveness.session.id
    : undefined;
}

export function museBackend(deps: MuseDeps = {}): ActuatorBackend {
  return {
    harness: 'muse',
    async wake(spec, ctx) {
      const bin = await (deps.resolveBin ?? resolveMuseBin)();
      if (!bin)
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason: 'muse CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      const liveness =
        deps.readSession?.(spec.workspace) ??
        localSessionLiveness(spec.workspace, Date.now(), undefined, 'muse');
      if (liveness.state === 'live' || liveness.slotState === 'live')
        return {
          outcome: { occupied: false, deferred: true, reason: 'local-session-live' },
          settled: Promise.resolve(undefined),
        };
      const pinnedDir = (deps.ensurePinned ?? ensurePinnedMusterd)({
        node: process.execPath,
        binJs: process.argv[1] ?? '',
      });
      const spawn = deps.spawn ?? nodeSpawn;
      const maxSteps = spec.bounds.max_turns;
      const run = async (
        args: string[],
        label: 'fresh' | 'resumed',
        timeoutMs: number,
        sessionId: string,
      ): Promise<{
        occupied: boolean;
        deferred?: boolean;
        reason: string;
        settled: Promise<WakeCompletion | undefined>;
      }> => {
        const startedAt = Date.now();
        let child: ChildProcess;
        try {
          child = spawn(bin, args, {
            cwd: spec.workspace,
            env: museWakeEnv(process.env, spec.order.lease_id, pinnedDir, spec.gateway?.env),
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch (err) {
          return {
            occupied: false,
            reason: `spawn failed: ${(err as Error).message}`.slice(0, 200),
            settled: Promise.resolve(undefined),
          };
        }
        // ADR 546: the lease file, so `musterd <seat>` finds this wake. The session id is known
        // up front (`exec --session-id`), so the lease names it from spawn — no stdout parsing.
        // ADR 604: a dream order stamps `dream`. The MCP adapter reads the lease from the file:
        // Muse's stdio children receive MUSE_SESSION_ID but not MUSTERD_* (measured, ADR 619),
        // and the adapter descends from this run pid (measured — no serve daemon, unlike opencode).
        const lease =
          child.pid !== undefined
            ? holdWakeLease(
                spec.workspace,
                {
                  lease_id: spec.order.lease_id,
                  harness: 'muse',
                  pid: child.pid,
                  startedAt,
                  timeoutMs,
                  session_id: sessionId,
                  provenance: spec.order.derivation === 'dream' ? 'dream' : 'wake',
                },
                deps.lease,
              )
            : undefined;
        const watchdog = setTimeout(
          () => killTree(child, deps.killGraceMs ?? KILL_GRACE_MS),
          timeoutMs,
        );
        watchdog.unref();
        // ADR 436 clause 1: every wake settles and prices. Muse usage metering rides lane 3's
        // live work (the --json usage shape needs a credentialed run); until then the row
        // carries no dollars, like Grok's unverified ticks (ADR 364).
        const exited = new Promise<number | null>((resolve) => {
          child.once('exit', (code) => resolve(code));
          child.once('error', () => resolve(null));
        });
        const placeholder = `wake-${spec.order.lease_id}`;
        const settled: Promise<WakeCompletion | undefined> = exited.then(async (code) => {
          clearTimeout(watchdog);
          const yielded = lease?.settle() ?? false;
          const duration_ms = Date.now() - startedAt;
          ctx.log(
            `run for ${spec.order.seat} (${label}) settled: exit=${code ?? 'error'} ` +
              `wall=${(duration_ms / 1000).toFixed(1)}s`,
          );
          return {
            duration_ms,
            unpriced_reason: 'harness_price_unverified',
            captures: [{ harness: 'muse', ids: [placeholder, sessionId], id: sessionId }],
            ...(yielded ? { yielded: true } : {}),
          };
        });
        const verified = await ctx.verifyOccupied(
          spec.order.seat,
          label === 'resumed' ? (deps.resumeVerifyWindowMs ?? RESUME_VERIFY_WINDOW_MS) : undefined,
          startedAt,
        );
        // ADR 379: an unattested row the loop identified as this wake's own child is mine too.
        const mine = verified.lease_matched || verified.own_unattested;
        if (verified.occupied && mine) {
          ctx.log(
            `⚡ woke ${spec.order.seat}: session=${label} lease=${spec.order.lease_id} ` +
              `provenance=${verified.provenance ?? 'none'}` +
              (verified.own_unattested ? ' (own child, lease unattested — ADR 379)' : ''),
          );
          if (label === 'fresh') {
            (deps.recordFreshSession ?? recordFreshSession)(spec.workspace, sessionId, startedAt);
          }
          return { occupied: true, reason: '', settled };
        }
        killTree(child, deps.killGraceMs ?? KILL_GRACE_MS);
        const heldByOther = verified.occupied && !mine;
        return {
          occupied: false,
          ...(heldByOther ? { deferred: true } : {}),
          reason: heldByOther
            ? `the seat is held by another session (provenance ${verified.provenance ?? 'none'})`
            : 'no roster Presence attesting this wake lease',
          settled,
        };
      };

      const captured = capturedId(liveness);
      const wantsResume = spec.order.intended_delivery !== 'fresh';
      if (captured && wantsResume) {
        const resumed = await run(
          buildMuseResumeArgs(
            spec.order.composed_line,
            captured,
            spec.workspace,
            maxSteps !== undefined ? { maxSteps } : {},
          ),
          'resumed',
          spec.bounds.timeout_ms,
          captured,
        );
        if (resumed.occupied)
          return { outcome: { occupied: true, session: 'resumed' }, settled: resumed.settled };
        if (resumed.deferred)
          return {
            outcome: {
              occupied: false,
              deferred: true,
              session: 'resumed',
              reason: resumed.reason,
            },
            settled: resumed.settled,
          };
        ctx.log(
          `resume failed for ${spec.order.seat} (${resumed.reason}) — fresh fallback in the same lease`,
        );
      }
      const sessionId = (deps.newSessionId ?? randomUUID)();
      const fresh = await run(
        buildMuseFreshArgs(
          spec.order.composed_line,
          spec.workspace,
          maxSteps !== undefined ? { sessionId, maxSteps } : { sessionId },
        ),
        'fresh',
        spec.bounds.timeout_ms,
        sessionId,
      );
      return {
        outcome: {
          occupied: fresh.occupied,
          ...(fresh.deferred ? { deferred: true } : {}),
          session: 'fresh',
          ...(fresh.occupied ? {} : { reason: fresh.reason }),
        },
        settled: fresh.settled,
      };
    },
  };
}
