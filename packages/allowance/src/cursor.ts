import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shareWindow, type ShareMiss, type ShareRead } from './codex.js';
import type { LiveProvider, Window } from './types.js';

const execFileAsync = promisify(execFile);

const URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

/** The keychain item the Cursor CLI writes on macOS. */
const KEYCHAIN_SERVICE = 'cursor-access-token';
const KEYCHAIN_ACCOUNT = 'cursor-user';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A billing-cycle instant. Cursor sends epoch milliseconds, often as a string. */
export function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return Math.round(value);
    if (value > 1_000_000_000) return Math.round(value * 1000);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{10,13}$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return value.length >= 13 ? parsed : parsed * 1000;
}

/** The included window is monthly when the cycle is about a month. Otherwise it stays "included". */
export function includedLabel(start: number | null, end: number | null): string {
  if (start === null || end === null || end <= start) return 'included window';
  const days = (end - start) / 86_400_000;
  return days >= 27 && days <= 32 ? 'monthly window' : 'included window';
}

function onDemand(spend: Record<string, unknown>, resetsAt: number | null): Window | null {
  const limitCents = finite(spend['individualLimit']);
  if (limitCents === null || limitCents <= 0) return null;
  const usedField = finite(spend['individualUsed']);
  const remaining = finite(spend['individualRemaining']);
  const usedCents =
    usedField !== null
      ? Math.max(0, usedField)
      : remaining !== null
        ? Math.max(0, limitCents - remaining)
        : 0;
  return {
    id: 'on-demand',
    unit: 'dollars',
    used: usedCents / 100,
    limit: limitCents / 100,
    resetsAt,
  };
}

/**
 * The body Cursor's usage screen reads.
 * A display message can carry an address, so it is never copied out.
 * Auto and API percents are shares of the included pool, not their own caps.
 */
export function parseCursor(body: unknown): ShareRead | ShareMiss {
  if (body === null || typeof body !== 'object') {
    return { state: 'error', reason: 'Cursor sent something we could not read.' };
  }
  const row = body as Record<string, unknown>;
  const end = epochMs(row['billingCycleEnd']);
  const start = epochMs(row['billingCycleStart']);
  const windows: Window[] = [];
  const plan = row['planUsage'];
  if (plan !== null && typeof plan === 'object') {
    const used = finite((plan as Record<string, unknown>)['totalPercentUsed']);
    if (used !== null && used >= 0) {
      windows.push(shareWindow('included', includedLabel(start, end), used, end));
    }
  }
  const spend = row['spendLimitUsage'];
  if (spend !== null && typeof spend === 'object') {
    const demand = onDemand(spend as Record<string, unknown>, end);
    if (demand !== null) windows.push(demand);
  }
  if (windows.length === 0) {
    return { state: 'error', reason: 'Cursor left out the windows.' };
  }
  return { state: 'live', detail: null, windows };
}

/** The access token from Cursor's auth.json. The token stays with the caller. */
export function cursorToken(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const token = (body as Record<string, unknown>)['accessToken'];
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

/**
 * Explicit token wins, including an explicit null that means "do not look".
 * Otherwise the file, then the lookup (the macOS keychain on a real machine).
 */
export async function resolveCursorToken(
  explicit: string | null | undefined,
  file: unknown,
  lookup: () => Promise<string | null>,
): Promise<string | null> {
  if (explicit !== undefined) return explicit === '' ? null : explicit;
  const fromFile = cursorToken(file);
  if (fromFile !== null) return fromFile;
  return lookup();
}

/** The Cursor CLI's macOS keychain item. Stdout is the token and is never logged. */
export async function cursorTokenFromKeychain(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeout: 3_000, maxBuffer: 8_192 },
    );
    const token = stdout.trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

export async function readCursor(
  token: string | null,
  fetchSub: typeof fetch,
  signal: AbortSignal,
): Promise<ShareRead | ShareMiss> {
  if (token === null || token === '') {
    return { state: 'missing', reason: 'Sign in to Cursor on this machine, then refresh.' };
  }
  let response: Response;
  try {
    response = await fetchSub(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Accept: 'application/json',
        'User-Agent': 'allowance/0.1',
      },
      body: '{}',
      redirect: 'error',
      signal,
    });
  } catch {
    return { state: 'error', reason: 'Cursor did not answer.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'error', reason: 'Cursor refused the sign-in.' };
  }
  if (response.status !== 200) {
    return { state: 'error', reason: 'Cursor did not answer.' };
  }
  try {
    return parseCursor(await response.json());
  } catch {
    return { state: 'error', reason: 'Cursor sent something we could not read.' };
  }
}

export function asCursor(read: ShareRead): LiveProvider {
  return {
    id: 'cursor',
    name: 'Cursor',
    state: 'live',
    detail: read.detail,
    windows: read.windows,
  };
}
