import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shareWindow, windowLabel, type ShareMiss, type ShareRead } from './codex.js';
import type { LiveProvider, Window } from './types.js';

const execFileAsync = promisify(execFile);

const NOT_INSTALLED = 'Muse is not installed on this machine.';
const NO_ANSWER = 'Muse did not answer.';
const SIGN_IN = 'Sign in to Muse on this machine, then refresh.';
const NO_USAGE = 'Muse sent no usage for this window yet.';
const NO_ALLOWANCE = 'Muse has no subscription allowance on this login.';
const API_KEY = 'This Muse login is an API key, which has no subscription window.';
const LEFT_OUT = 'Muse left out the windows.';
const UNREADABLE = 'Muse sent something we could not read.';

export interface MuseRun {
  stdout: string;
  stderr: string;
  /** Set when the binary is missing, or when the command did not finish. */
  errorCode?: 'ENOENT' | 'TIMEOUT';
}

interface ExecError extends NodeJS.ErrnoException {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  killed?: boolean;
}

function textOf(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Epoch milliseconds. Values above 1e12 are already ms. Values above 1e9 are seconds. */
function epochMs(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed === null) return null;
  if (parsed > 1_000_000_000_000) return Math.round(parsed);
  if (parsed > 1_000_000_000) return Math.round(parsed * 1000);
  return null;
}

function usedPercent(row: Record<string, unknown>): number | null {
  const value = finite(row['usedPercent'] ?? row['used_percent']);
  if (value === null || value < 0) return null;
  return value;
}

function durationMins(row: Record<string, unknown>): number | null {
  const value = finite(row['windowDurationMins'] ?? row['window_duration_mins']);
  if (value === null || value <= 0) return null;
  return value;
}

function resetsAt(row: Record<string, unknown>): number | null {
  return epochMs(row['resetsAtMs'] ?? row['resets_at_ms'] ?? row['resetsAt'] ?? row['resets_at']);
}

function notSignedIn(text: string): boolean {
  return /not logged in/i.test(text);
}

function nullAllowance(row: Record<string, unknown>): ShareMiss {
  const reason = typeof row['reason'] === 'string' ? row['reason'] : '';
  const hint = typeof row['hint'] === 'string' ? row['hint'] : '';
  if (reason === 'no_allowance') return { state: 'missing', reason: NO_ALLOWANCE };
  if (reason === 'api_key') return { state: 'missing', reason: API_KEY };
  if (notSignedIn(reason) || notSignedIn(hint)) return { state: 'missing', reason: SIGN_IN };
  return { state: 'missing', reason: NO_USAGE };
}

function currentWindow(row: Record<string, unknown>, id: string): Window | null {
  const used = usedPercent(row);
  const mins = durationMins(row);
  const reset = resetsAt(row);
  if (used === null || mins === null || reset === null) return null;
  return shareWindow(id, windowLabel(mins * 60), used, reset);
}

function weeklyWindow(row: Record<string, unknown>): Window | null {
  const used = usedPercent(row);
  const reset = resetsAt(row);
  if (used === null || reset === null) return null;
  return shareWindow('weekly', 'weekly window', used, reset);
}

/**
 * `muse usage --json`. A null allowance is a reason and no number. The hint and the tier are
 * not copied out. A window needs a used percent and a reset. The current window also needs a
 * duration. The access token is not read here.
 */
export function parseMuseUsage(body: unknown): ShareRead | ShareMiss {
  if (body === null || typeof body !== 'object') return { state: 'error', reason: UNREADABLE };
  const row = body as Record<string, unknown>;
  if (row['schemaVersion'] !== 1) return { state: 'error', reason: UNREADABLE };
  if (!('allowance' in row) || row['allowance'] === null) return nullAllowance(row);
  const allowance = row['allowance'];
  if (allowance === null || typeof allowance !== 'object') {
    return { state: 'error', reason: UNREADABLE };
  }
  const box = allowance as Record<string, unknown>;
  const windows: Window[] = [];
  const windowRaw = box['window'];
  if (windowRaw !== undefined && windowRaw !== null) {
    if (typeof windowRaw === 'object') {
      const parsed = currentWindow(windowRaw as Record<string, unknown>, 'session');
      if (parsed) windows.push(parsed);
    }
  } else {
    const flat = currentWindow(box, 'session');
    if (flat) windows.push(flat);
  }
  const weeklyRaw = box['weekly'];
  if (weeklyRaw !== null && typeof weeklyRaw === 'object') {
    const weekly = weeklyWindow(weeklyRaw as Record<string, unknown>);
    if (weekly) windows.push(weekly);
  }
  if (windows.length === 0) return { state: 'error', reason: LEFT_OUT };
  return { state: 'live', detail: null, windows };
}

/** Parse one CLI payload. A non-JSON "not logged in" line is a sign-in miss, not an error. */
export function parseMuseText(text: string): ShareRead | ShareMiss {
  const trimmed = text.trim();
  if (trimmed !== '' && notSignedIn(trimmed) && !trimmed.startsWith('{')) {
    return { state: 'missing', reason: SIGN_IN };
  }
  try {
    return parseMuseUsage(JSON.parse(trimmed) as unknown);
  } catch {
    return { state: 'error', reason: UNREADABLE };
  }
}

/** Map one CLI result. A timeout wins over a partial stdout. JSON on a non-zero exit still parses. */
export function interpretMuseRun(result: MuseRun): ShareRead | ShareMiss {
  if (result.errorCode === 'ENOENT') return { state: 'missing', reason: NOT_INSTALLED };
  if (result.errorCode === 'TIMEOUT') return { state: 'error', reason: NO_ANSWER };
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (stdout.trim() !== '') return parseMuseText(stdout);
  if (notSignedIn(stderr)) return { state: 'missing', reason: SIGN_IN };
  return { state: 'error', reason: NO_ANSWER };
}

async function runMuseCli(signal?: AbortSignal): Promise<MuseRun> {
  try {
    const { stdout, stderr } = await execFileAsync('muse', ['usage', '--json'], {
      timeout: 5_000,
      maxBuffer: 65_536,
      signal,
      windowsHide: true,
    });
    return { stdout: textOf(stdout), stderr: textOf(stderr) };
  } catch (err) {
    const error = err as ExecError;
    const stdout = textOf(error.stdout);
    const stderr = textOf(error.stderr);
    if (error.code === 'ENOENT') return { stdout, stderr, errorCode: 'ENOENT' };
    if (error.killed || error.code === 'ABORT_ERR' || signal?.aborted) {
      return { stdout, stderr, errorCode: 'TIMEOUT' };
    }
    return { stdout, stderr };
  }
}

/** Read the local Muse CLI. Tests pass `run` so the suite does not spawn `muse`. */
export async function readMuse(
  signal?: AbortSignal,
  run: (signal?: AbortSignal) => Promise<MuseRun> = runMuseCli,
): Promise<ShareRead | ShareMiss> {
  try {
    return interpretMuseRun(await run(signal));
  } catch {
    return { state: 'error', reason: NO_ANSWER };
  }
}

export function asMuse(read: ShareRead): LiveProvider {
  return {
    id: 'muse',
    name: 'Muse',
    state: 'live',
    detail: null,
    windows: read.windows,
  };
}
