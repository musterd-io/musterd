import type { LiveProvider, Window } from './types.js';

const URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface CodexSession {
  token: string;
  account: string;
}

export interface ShareRead {
  state: 'live';
  detail: string | null;
  windows: Window[];
}

export interface ShareMiss {
  state: 'missing' | 'error';
  reason: string;
}

interface RawWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A window length we will name. Anything else is still a window, unnamed beyond "window". */
export function windowLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    if (days === 1) return 'daily window';
    if (days === 7) return 'weekly window';
    return `${days}-day window`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? 'hourly window' : `${hours}-hour window`;
  }
  return 'window';
}

export function shareWindow(
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: number | null,
): Window {
  return {
    id,
    unit: 'percent',
    used: Math.max(0, Math.round(usedPercent)),
    limit: 100,
    resetsAt,
    label,
  };
}

function oneWindow(id: string, raw: unknown): Window | null {
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as RawWindow;
  const used = finite(row.used_percent);
  const seconds = finite(row.limit_window_seconds);
  if (used === null || used < 0 || seconds === null || !Number.isInteger(seconds) || seconds <= 0) {
    return null;
  }
  const reset = finite(row.reset_at);
  const resetsAt =
    reset !== null && Number.isInteger(reset) && reset > 1_000_000_000 ? reset * 1000 : null;
  return shareWindow(id, windowLabel(seconds), used, resetsAt);
}

function planWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const word = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/.test(word) ? word : null;
}

/** The Codex usage body. Email, user id and account id are never copied out. */
export function parseCodex(body: unknown): ShareRead | ShareMiss {
  if (body === null || typeof body !== 'object') {
    return { state: 'error', reason: 'Codex sent something we could not read.' };
  }
  const row = body as Record<string, unknown>;
  const rate = row['rate_limit'];
  if (rate === null || typeof rate !== 'object') {
    return { state: 'error', reason: 'Codex left out the windows.' };
  }
  const windows = [
    oneWindow('primary', (rate as Record<string, unknown>)['primary_window']),
    oneWindow('secondary', (rate as Record<string, unknown>)['secondary_window']),
  ].filter((window): window is Window => window !== null);
  if (windows.length === 0) {
    return { state: 'error', reason: 'Codex left out the windows.' };
  }
  return { state: 'live', detail: planWord(row['plan_type']), windows };
}

/** The ChatGPT sign-in Codex stored. The token stays with the caller. */
export function codexSession(body: unknown): CodexSession | null {
  if (body === null || typeof body !== 'object') return null;
  const tokens = (body as Record<string, unknown>)['tokens'];
  if (tokens === null || typeof tokens !== 'object') return null;
  const row = tokens as Record<string, unknown>;
  const token = typeof row['access_token'] === 'string' ? row['access_token'].trim() : '';
  const account = typeof row['account_id'] === 'string' ? row['account_id'].trim() : '';
  if (token === '' || account === '') return null;
  return { token, account };
}

export async function readCodex(
  session: CodexSession | null,
  fetchSub: typeof fetch,
  signal: AbortSignal,
): Promise<ShareRead | ShareMiss> {
  if (session === null) {
    return { state: 'missing', reason: 'Sign in to Codex on this machine, then refresh.' };
  }
  let response: Response;
  try {
    response = await fetchSub(URL, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        'ChatGPT-Account-Id': session.account,
        Accept: 'application/json',
        'User-Agent': 'allowance/0.1',
      },
      redirect: 'error',
      signal,
    });
  } catch {
    return { state: 'error', reason: 'Codex did not answer.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'error', reason: 'Codex refused the sign-in.' };
  }
  if (response.status !== 200) {
    return { state: 'error', reason: 'Codex did not answer.' };
  }
  try {
    return parseCodex(await response.json());
  } catch {
    return { state: 'error', reason: 'Codex sent something we could not read.' };
  }
}

export function asCodex(read: ShareRead): LiveProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    state: 'live',
    detail: read.detail,
    windows: read.windows,
  };
}
