import { execFile, execFileSync, type ExecFileException } from 'node:child_process';
import { findBinding } from '../binding.js';
import type { InjectAdapter, InjectResult, Probe } from './inject.js';

/**
 * Codex's inject (ADR 558 §6). `codex queue --thread <id> --message <line>` wakes an idle TUI.
 * The thread id is the binding session id `musterd codex-hook start` stored at SessionStart.
 *
 * Probe checks that id before it runs `codex --version`, so a directory with no live codex
 * session never spawns the CLI. Below 0.149.0 the probe is `below-0.149`. A missing binary or a
 * version line with no `x.y.z` is `no-codex`.
 *
 * Measured 2026-10-16 on codex-cli 0.162.1 talking to app-server 0.163.0: an idle TUI
 * (`--no-alt-screen -s read-only`) rendered the queued turn (n=2), and a half-typed draft that
 * was on screen stayed in the composer (n=1). An open approval dialog was not measured. Reasons
 * are stable codes. Stderr, the line, and paths are never copied into a reason. Terminal
 * injection stays refused.
 */
const VERSION_MS = 5_000;
const QUEUE_MS = 15_000;
const MIN_VERSION = [0, 149, 0] as const;
/** First character is not `-`, so the id cannot be read as a flag. */
const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export interface CodexSessionView {
  harness: string;
  id: string;
  ended_at?: number;
}

export interface CodexQueueDeps {
  readSession?: (dir: string) => CodexSessionView | undefined;
  /** Stdout of `codex --version`, or undefined when the command fails. */
  versionText?: () => string | undefined;
  /** Runs the already-built argv. Default is `execFile('codex', args)` with no shell. */
  queue?: (args: readonly string[]) => Promise<InjectResult>;
}

function defaultReadSession(dir: string): CodexSessionView | undefined {
  try {
    // Empty env: this is a judgement about `dir`, and MUSTERD_BINDING must not redirect it.
    const session = findBinding(dir, {})?.session;
    if (!session) return undefined;
    const view: CodexSessionView = { harness: session.harness, id: session.id };
    if (session.ended_at !== undefined) view.ended_at = session.ended_at;
    return view;
  } catch {
    return undefined;
  }
}

function defaultVersionText(): string | undefined {
  try {
    return execFileSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_MS,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/** Map an `execFile` error to a stable reason. `null` is exit 0. */
export function codexQueueResult(err: ExecFileException | null): InjectResult {
  if (!err) return { ok: true };
  if (err.killed || err.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if (typeof err.code === 'number') return { ok: false, reason: 'queue-rejected' };
  return { ok: false, reason: 'spawn-failed' };
}

function defaultQueue(args: readonly string[]): Promise<InjectResult> {
  return new Promise((resolve) => {
    execFile('codex', [...args], { timeout: QUEUE_MS, maxBuffer: 1 << 20 }, (err) =>
      resolve(codexQueueResult(err)),
    );
  });
}

function liveThread(session: CodexSessionView | undefined): string | undefined {
  if (!session || session.harness !== 'codex') return undefined;
  if (session.ended_at !== undefined) return undefined;
  if (!THREAD_RE.test(session.id)) return undefined;
  return session.id;
}

function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast149(version: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const part = version[i] ?? 0;
    const min = MIN_VERSION[i] ?? 0;
    if (part > min) return true;
    if (part < min) return false;
  }
  return true;
}

export function codexQueue(dir: string, deps: CodexQueueDeps = {}): InjectAdapter {
  const readSession = deps.readSession ?? defaultReadSession;
  const versionText = deps.versionText ?? defaultVersionText;
  const queue = deps.queue ?? defaultQueue;
  let versionProbe: Probe | undefined;

  const versionGate = (): Probe => {
    if (versionProbe) return versionProbe;
    const text = versionText();
    const parsed = text === undefined ? undefined : parseVersion(text);
    if (!parsed) versionProbe = { ready: false, reason: 'no-codex' };
    else if (!atLeast149(parsed)) versionProbe = { ready: false, reason: 'below-0.149' };
    else versionProbe = { ready: true };
    return versionProbe;
  };

  const probe = (): Probe => {
    if (!liveThread(readSession(dir))) return { ready: false, reason: 'no-thread' };
    return versionGate();
  };

  const inject = (line: string): Promise<InjectResult> => {
    const thread = liveThread(readSession(dir));
    if (!thread) return Promise.resolve({ ok: false, reason: 'no-thread' });
    const gate = versionGate();
    if (!gate.ready) return Promise.resolve({ ok: false, reason: gate.reason });
    return queue(['queue', '--thread', thread, '--message', line]);
  };

  return { harness: 'codex', probe, inject };
}
