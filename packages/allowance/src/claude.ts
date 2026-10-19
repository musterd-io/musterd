import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shareWindow, type ShareMiss, type ShareRead } from './codex.js';
import type { LiveProvider, Window } from './types.js';

const execFileAsync = promisify(execFile);

/** The keychain item Claude Code writes on macOS. The account is the OS user. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const URL = 'https://api.anthropic.com/api/oauth/usage';

const NAMED: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'weekly window',
};

/** Plan words Claude Code shows. An unknown subscription or tier is not printed. */
const PLAN: Record<string, string> = {
  max: 'Claude Max',
  pro: 'Claude Pro',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise',
};

const MAX_TIER: Record<string, string> = {
  default_claude_max_5x: 'Claude Max 5x',
  default_claude_max_20x: 'Claude Max 20x',
};

/** A server model name, such as Fable. Anything else is dropped. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,40}$/;

export interface ClaudeSignIn {
  token: string;
  plan: string | null;
}

function labelFor(key: string): string | null {
  if (key.includes('overage')) return null;
  if (NAMED[key]) return NAMED[key];
  const weekly = /^seven_day_([a-z0-9]+)$/.exec(key);
  if (weekly?.[1]) return `weekly ${weekly[1]} window`;
  return null;
}

function resetsAt(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value > 1_000_000_000_000) return Math.round(value);
  if (value > 1_000_000_000) return Math.round(value * 1000);
  return null;
}

function modelName(scope: unknown): string | null {
  if (scope === null || typeof scope !== 'object') return null;
  const model = (scope as Record<string, unknown>)['model'];
  if (model === null || typeof model !== 'object') return null;
  const name = (model as Record<string, unknown>)['display_name'];
  if (typeof name !== 'string') return null;
  const word = name.trim();
  return MODEL_NAME.test(word) ? word : null;
}

/**
 * `limits` is the list Claude Code classifies by `kind`.
 * `session` and `weekly_all` are the same meters as `five_hour` and `seven_day`.
 * `weekly_scoped` is one model's own weekly window. Null means the list was absent or empty.
 */
function windowsFromLimits(row: Record<string, unknown>): Window[] | null {
  const limits = row['limits'];
  if (!Array.isArray(limits)) return null;
  const windows = limits
    .map((item, index) => {
      if (item === null || typeof item !== 'object') return null;
      const limit = item as Record<string, unknown>;
      const kind = limit['kind'];
      if (kind !== 'session' && kind !== 'weekly_all' && kind !== 'weekly_scoped') return null;
      const label =
        kind === 'session'
          ? '5-hour window'
          : kind === 'weekly_all'
            ? 'weekly window'
            : modelName(limit['scope']);
      if (label === null) return null;
      const percent = limit['percent'];
      if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
      const id = kind === 'weekly_scoped' ? `weekly_scoped_${index}` : kind;
      const text = kind === 'weekly_scoped' ? `${label} weekly window` : label;
      return shareWindow(id, text, percent, resetsAt(limit['resets_at']));
    })
    .filter((window) => window !== null);
  return windows.length === 0 ? null : windows;
}

function windowsFromKeys(row: Record<string, unknown>): Window[] {
  return Object.keys(row)
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
}

/**
 * The body Claude Code reads for /usage.
 * When `limits` is present, those rows are the windows. Otherwise `five_hour` and `seven_day`
 * carry utilization and resets_at. Overage is not a window.
 */
export function parseClaude(body: unknown): ShareRead | ShareMiss {
  if (body === null || typeof body !== 'object') {
    return { state: 'error', reason: 'Claude sent something we could not read.' };
  }
  const row = body as Record<string, unknown>;
  const windows = windowsFromLimits(row) ?? windowsFromKeys(row);
  if (windows.length === 0) {
    return { state: 'error', reason: 'Claude left out the windows.' };
  }
  return { state: 'live', detail: null, windows };
}

/** The plan word from a Claude Code credentials file. The token is not read here. */
export function claudePlan(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const oauth = (body as Record<string, unknown>)['claudeAiOauth'];
  if (oauth === null || typeof oauth !== 'object') return null;
  const row = oauth as Record<string, unknown>;
  const subscription =
    typeof row['subscriptionType'] === 'string' ? row['subscriptionType'].trim() : '';
  if (subscription === 'max') {
    const tier = typeof row['rateLimitTier'] === 'string' ? row['rateLimitTier'].trim() : '';
    return MAX_TIER[tier] ?? 'Claude Max';
  }
  return PLAN[subscription] ?? null;
}

/** The access token from a Claude Code credentials file. The token stays with the caller. */
export function claudeToken(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const oauth = (body as Record<string, unknown>)['claudeAiOauth'];
  if (oauth === null || typeof oauth !== 'object') return null;
  const token = (oauth as Record<string, unknown>)['accessToken'];
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

/** Token plus plan from a credentials body. Null when there is no access token. */
export function claudeSignInFromBody(body: unknown): ClaudeSignIn | null {
  const token = claudeToken(body);
  if (token === null) return null;
  return { token, plan: claudePlan(body) };
}

/**
 * Explicit token wins, including an explicit null that means "do not look".
 * Otherwise the environment, then the credentials file, then the lookup.
 * A plan is taken from the credentials body when that body has one.
 */
export async function resolveClaudeSignIn(
  explicit: string | null | undefined,
  env: NodeJS.ProcessEnv,
  file: unknown,
  lookup: () => Promise<ClaudeSignIn | null>,
): Promise<ClaudeSignIn | null> {
  if (explicit !== undefined) {
    if (explicit === null || explicit === '') return null;
    return { token: explicit, plan: claudePlan(file) };
  }
  const fromEnv = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim() ?? '';
  const fromFile = claudeSignInFromBody(file);
  if (fromEnv !== '') return { token: fromEnv, plan: fromFile?.plan ?? null };
  if (fromFile !== null) return fromFile;
  return lookup();
}

/**
 * Claude Code's macOS keychain item. It holds the credentials JSON.
 * Stdout is that JSON and is never logged. Only the access token and the plan word come back.
 */
export async function claudeSignInFromKeychain(): Promise<ClaudeSignIn | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 3_000, maxBuffer: 65_536 },
    );
    const text = stdout.trim();
    if (text === '') return null;
    if (text.startsWith('{')) {
      try {
        return claudeSignInFromBody(JSON.parse(text) as unknown);
      } catch {
        return null;
      }
    }
    return { token: text, plan: null };
  } catch {
    return null;
  }
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

export function asClaude(read: ShareRead, plan: string | null = null): LiveProvider {
  return {
    id: 'claude',
    name: 'Claude',
    state: 'live',
    detail: plan ?? read.detail,
    windows: read.windows,
  };
}
