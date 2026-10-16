import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { WakeUsage } from '@musterd/protocol';
import { findBinding, saveBinding } from '../../config.js';
import { resolveCursorAgentBin } from '../../cursorAgentBin.js';
import { enumerateCursorSessions } from '../../session/enumerate.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type { ActuatorBackend, WakeActuation, WakeCompletion } from '../backend.js';
import { ensurePinnedMusterd, wakeEnv } from '../pinnedBin.js';
import { holdWakeLease, type WakeLeaseDeps } from '../wakeLeaseFile.js';

const KILL_GRACE_MS = 10_000;
const RESUME_VERIFY_WINDOW_MS = 30_000;

/**
 * Flags measured on `cursor-agent` 2026.10.01-e373342 (`--help`, not a guessed spelling).
 * `--print` is the headless form (tools included). `--trust` skips the workspace prompt.
 * `--approve-mcps` is what lets the seat's musterd server connect without a person at the
 * keyboard. `--force` and `--yolo` are on the binary and are not passed: a wake does not
 * bypass the harness's own command denials.
 */
export function buildCursorAgentFreshArgs(line: string, workspace: string): string[] {
  return ['--trust', '--print', '--approve-mcps', '--workspace', workspace, line];
}

export function buildCursorAgentResumeArgs(
  line: string,
  sessionId: string,
  workspace: string,
): string[] {
  return [
    '--trust',
    '--print',
    '--approve-mcps',
    '--resume',
    sessionId,
    '--workspace',
    workspace,
    line,
  ];
}

export function cursorAgentWakeEnv(
  base: NodeJS.ProcessEnv,
  leaseId?: string,
  pinnedDir?: string,
  /** ADR 583: the metering gateway's base-URL variables, applied last. */
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  // Auth is the login cursor-agent stores under HOME. CURSOR_API_KEY is a secret and is not copied.
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'MUSTERD_MODEL'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key];
  return wakeEnv(env, pinnedDir, leaseId, 'cursor', extra);
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

/**
 * The transcript enumeration already attributes (ADR 265), newest file touched at or after
 * this spawn. `undefined` from the scan means "cannot tell", which is not a session id.
 */
export function findCursorWakeSessionId(workspace: string, startedAt: number): string | undefined {
  try {
    const rows = enumerateCursorSessions(workspace);
    if (!rows) return undefined;
    let best: { id: string; mtime: number } | undefined;
    for (const row of rows) {
      if (row.mtime < startedAt) continue;
      if (!best || row.mtime > best.mtime) best = row;
    }
    return best?.id;
  } catch {
    return undefined;
  }
}

export interface CursorAgentDeps {
  resolveBin?: () => Promise<string | null>;
  lease?: WakeLeaseDeps;
  spawn?: typeof nodeSpawn;
  readSession?: (workspace: string) => LocalSessionLiveness;
  recordFreshSession?: (workspace: string, id: string, startedAt: number) => void;
  killGraceMs?: number;
  resumeVerifyWindowMs?: number;
  ensurePinned?: (opts: { node: string; binJs: string }) => string | undefined;
  /** Usage the harness wrote for this wake. Absent ⇒ the settle row carries no token counts. */
  readUsage?: (workspace: string, startedAt: number) => WakeUsage | undefined;
  /** The real session id of a fresh wake, read once the child is up. */
  findSessionId?: (workspace: string, startedAt: number) => string | undefined;
}

function recordFreshSession(workspace: string, id: string, startedAt: number): void {
  const binding = findBinding(workspace, {});
  if (!binding) return;
  saveBinding(workspace, {
    ...binding,
    session: { harness: 'cursor', id, started_at: startedAt },
  });
}

function capturedId(liveness: LocalSessionLiveness): string | undefined {
  return liveness.state === 'resumable' && liveness.session?.harness === 'cursor'
    ? liveness.session.id
    : undefined;
}

export function cursorAgentBackend(deps: CursorAgentDeps = {}): ActuatorBackend {
  return {
    harness: 'cursor',
    async wake(spec, ctx): Promise<WakeActuation> {
      const bin = await (deps.resolveBin ?? resolveCursorAgentBin)();
      if (!bin)
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason: 'cursor-agent CLI not found (PATH + known install locations)',
          },
          settled: Promise.resolve(undefined),
        };
      const liveness =
        deps.readSession?.(spec.workspace) ??
        localSessionLiveness(spec.workspace, Date.now(), undefined, 'cursor');
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
      const run = async (
        args: string[],
        label: 'fresh' | 'resumed',
        timeoutMs: number,
        resumeId?: string,
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
            env: cursorAgentWakeEnv(process.env, spec.order.lease_id, pinnedDir, spec.gateway?.env),
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
        const lease =
          child.pid !== undefined
            ? holdWakeLease(
                spec.workspace,
                {
                  lease_id: spec.order.lease_id,
                  harness: 'cursor',
                  pid: child.pid,
                  startedAt,
                  timeoutMs,
                  session_id: resumeId,
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
          const usage = deps.readUsage?.(spec.workspace, startedAt);
          const realId =
            label === 'fresh'
              ? (deps.findSessionId ?? findCursorWakeSessionId)(spec.workspace, startedAt)
              : undefined;
          return {
            duration_ms,
            ...(usage ? { usage } : {}),
            // No credentialed run has priced a cursor-agent wake. Tokens, when a reader
            // supplies them, still do not become a dollar figure (ADR 364).
            unpriced_reason: 'harness_price_unverified',
            captures: [{ harness: 'cursor', ids: [placeholder, resumeId], id: realId }],
            ...(yielded ? { yielded: true } : {}),
          };
        });
        const verified = await ctx.verifyOccupied(
          spec.order.seat,
          label === 'resumed' ? (deps.resumeVerifyWindowMs ?? RESUME_VERIFY_WINDOW_MS) : undefined,
          startedAt,
        );
        const mine = verified.lease_matched || verified.own_unattested;
        if (verified.occupied && mine) {
          ctx.log(
            `⚡ woke ${spec.order.seat}: session=${label} lease=${spec.order.lease_id} ` +
              `provenance=${verified.provenance ?? 'none'}` +
              (verified.own_unattested ? ' (own child, lease unattested — ADR 379)' : ''),
          );
          if (label === 'fresh') {
            (deps.recordFreshSession ?? recordFreshSession)(spec.workspace, placeholder, startedAt);
            const live = (deps.findSessionId ?? findCursorWakeSessionId)(spec.workspace, startedAt);
            if (live) lease?.setSession(live);
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
          buildCursorAgentResumeArgs(spec.order.composed_line, captured, spec.workspace),
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
      const fresh = await run(
        buildCursorAgentFreshArgs(spec.order.composed_line, spec.workspace),
        'fresh',
        spec.bounds.timeout_ms,
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
