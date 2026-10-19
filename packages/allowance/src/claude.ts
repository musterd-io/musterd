import { shareWindow, type ShareMiss, type ShareRead } from './codex.js';
import type { LiveProvider } from './types.js';

const URL = 'https://api.anthropic.com/api/oauth/usage';

const NAMED: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'weekly window',
};

function labelFor(key: string): string | null {
  if (key.includes('overage')) return null;
  if (NAMED[key]) return NAMED[key];
  const weekly = /^seven_day_([a-z0-9]+)$/.exec(key);
  if (weekly?.[1]) return `weekly ${weekly[1]} window`;
  return null;
}

function resetsAt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value > 1_000_000_000_000) return Math.round(value);
  if (value > 1_000_000_000) return Math.round(value * 1000);
  return null;
}

/**
 * The body Claude Code reads for /usage.
 * `five_hour` and `seven_day` carry utilization and resets_at. Overage is not a window.
 */
export function parseClaude(body: unknown): ShareRead | ShareMiss {
  if (body === null || typeof body !== 'object') {
    return { state: 'error', reason: 'Claude sent something we could not read.' };
  }
  const row = body as Record<string, unknown>;
  const windows = Object.keys(row)
    .map((key) => {
      const label = labelFor(key);
      const raw = row[key];
      if (label === null || raw === null || typeof raw !== 'object') return null;
      const utilization = (raw as Record<string, unknown>)['utilization'];
      if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) {
        return null;
      }
      return shareWindow(
        key,
        label,
        utilization,
        resetsAt((raw as Record<string, unknown>)['resets_at']),
      );
    })
    .filter((window) => window !== null);
  if (windows.length === 0) {
    return { state: 'error', reason: 'Claude left out the windows.' };
  }
  return { state: 'live', detail: null, windows };
}

/** The access token from a Claude Code credentials file. The token stays with the caller. */
export function claudeToken(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const oauth = (body as Record<string, unknown>)['claudeAiOauth'];
  if (oauth === null || typeof oauth !== 'object') return null;
  const token = (oauth as Record<string, unknown>)['accessToken'];
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

export function claudeTokenFromEnv(env: NodeJS.ProcessEnv, file: unknown): string | null {
  const fromEnv = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim() ?? '';
  if (fromEnv !== '') return fromEnv;
  return claudeToken(file);
}

export async function readClaude(
  token: string | null,
  fetchSub: typeof fetch,
  signal: AbortSignal,
): Promise<ShareRead | ShareMiss> {
  if (token === null || token === '') {
    return {
      state: 'missing',
      reason:
        'Sign in to Claude Code on this machine, or set CLAUDE_CODE_OAUTH_TOKEN, then refresh.',
    };
  }
  let response: Response;
  try {
    response = await fetchSub(URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'allowance/0.1',
      },
      redirect: 'error',
      signal,
    });
  } catch {
    return { state: 'error', reason: 'Claude did not answer.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'error', reason: 'Claude refused the sign-in.' };
  }
  if (response.status !== 200) {
    return { state: 'error', reason: 'Claude did not answer.' };
  }
  try {
    return parseClaude(await response.json());
  } catch {
    return { state: 'error', reason: 'Claude sent something we could not read.' };
  }
}

export function asClaude(read: ShareRead): LiveProvider {
  return {
    id: 'claude',
    name: 'Claude',
    state: 'live',
    detail: read.detail,
    windows: read.windows,
  };
}
