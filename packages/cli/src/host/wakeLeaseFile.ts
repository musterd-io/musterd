import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BINDING_DIR,
  WAKE_LEASE_FILE,
  WAKE_YIELD_FILE,
  WakeYieldFileSchema,
  type WakeLeaseFile,
} from '@musterd/protocol';

/**
 * The actuator's half of the wake-lease file channel (ADR 354): written beside `binding.json` right
 * after a harness child is spawned, naming that child's pid, and cleared when the run settles. The
 * adapter's half (`packages/mcp/src/wakeLeaseFile.ts`) honours it only from a process whose parent
 * is that pid, and only while unexpired — so the write here is safe to make before verification
 * concludes, and a crash that leaves the file behind is bounded by `expires_at`.
 *
 * Best-effort on purpose: a workspace the actuator cannot write to must not fail the wake — the env
 * channel is still in place, and on a harness that forwards it the file is redundant anyway.
 */
export function writeWakeLeaseFile(workspace: string, lease: WakeLeaseFile): void {
  try {
    mkdirSync(join(workspace, BINDING_DIR), { recursive: true });
    const path = join(workspace, BINDING_DIR, WAKE_LEASE_FILE);
    writeFileSync(path, JSON.stringify(lease) + '\n', { mode: 0o600 });
    // `mode` on writeFileSync applies only when the file is CREATED. A file left world-readable by
    // an older build keeps its mode across the rewrite unless tightened explicitly.
    chmodSync(path, 0o600);
  } catch {
    /* best-effort: the env channel is still in place */
  }
}

/**
 * Remove the file — but only if it still carries THIS lease. A slower settle must not delete the
 * file a newer wake in the same workspace just wrote.
 */
export function clearWakeLeaseFile(workspace: string, leaseId: string): void {
  const path = join(workspace, BINDING_DIR, WAKE_LEASE_FILE);
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as { lease_id?: unknown };
    if (current.lease_id !== leaseId) return;
    rmSync(path, { force: true });
  } catch {
    /* already gone, or unreadable — nothing to clear */
  }
}

/**
 * Remove the yield marker if it names `leaseId` (ADR 546). True ⇒ this run was taken over. A marker
 * for another lease is left for that lease's run; a missing or unreadable one is no yield.
 */
export function takeYieldFile(workspace: string, leaseId: string): boolean {
  const path = join(workspace, BINDING_DIR, WAKE_YIELD_FILE);
  try {
    const parsed = WakeYieldFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success || parsed.data.lease_id !== leaseId) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * True while a yield marker naming `leaseId` exists — read, never removed (that is {@link takeYieldFile},
 * at settle). The native loop polls this: it has no `musterd gate` hook to deny its next tool call.
 */
export function peekYieldFile(workspace: string, leaseId: string): boolean {
  try {
    const parsed = WakeYieldFileSchema.safeParse(
      JSON.parse(readFileSync(join(workspace, BINDING_DIR, WAKE_YIELD_FILE), 'utf8')),
    );
    return parsed.success && parsed.data.lease_id === leaseId;
  } catch {
    return false;
  }
}

export interface WakeLeaseDeps {
  write?: (workspace: string, lease: WakeLeaseFile) => void;
  clear?: (workspace: string, leaseId: string) => void;
  takeYield?: (workspace: string, leaseId: string) => boolean;
}

/** A held wake lease file: rewrite it when the conversation id is learned, settle it at run exit. */
export interface WakeLeaseHandle {
  /** Record the harness's conversation id (ADR 546). A later id replaces an earlier one; a settled
   *  handle ignores it, so a slow discovery can never resurrect the file of a run that has ended. */
  setSession(id: string): void;
  /** The run ended: remove the file and consume the yield marker. True ⇒ a person took it over. */
  settle(): boolean;
}

/**
 * The lease-file bookkeeping every wake backend does the same way (ADR 354/546), in one place:
 * write after spawn, rewrite once the session id is known, clear and take the yield marker at exit.
 * Claude Code and Codex predate this and inline the same three calls; Grok, opencode and the native
 * loop use it, so a wake on any harness is findable by `musterd <seat>`.
 */
export function holdWakeLease(
  workspace: string,
  o: {
    lease_id: string;
    harness: string;
    /** The pid a launcher may signal as a process group (the detached harness child). */
    pid: number;
    startedAt: number;
    timeoutMs: number;
    session_id?: string | undefined;
    /** The wake is a loop inside this process: `pid` is the host's own and is never signalled. */
    in_process?: boolean | undefined;
  },
  deps: WakeLeaseDeps = {},
): WakeLeaseHandle {
  const write = deps.write ?? writeWakeLeaseFile;
  let session = o.session_id;
  let settled = false;
  const put = (): void =>
    write(workspace, {
      lease_id: o.lease_id,
      provenance: 'wake',
      harness: o.harness,
      spawner_pid: o.pid,
      started_at: o.startedAt,
      expires_at: o.startedAt + o.timeoutMs,
      ...(session ? { session_id: session } : {}),
      ...(o.in_process ? { in_process: true } : {}),
    });
  put();
  return {
    setSession(id) {
      if (settled || id === session) return;
      session = id;
      put();
    },
    settle() {
      settled = true;
      (deps.clear ?? clearWakeLeaseFile)(workspace, o.lease_id);
      return (deps.takeYield ?? takeYieldFile)(workspace, o.lease_id);
    },
  };
}
