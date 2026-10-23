import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

/**
 * One-way account key (ADR 723). `sha256(provider + NUL + material)`, 16 hex characters.
 * The material is a public id, a refresh token, or an API key. It never leaves this process,
 * and neither does the hash's input.
 */
export function accountKey(provider: string, material: string): string {
  return createHash('sha256').update(`${provider}\0${material}`).digest('hex').slice(0, 16);
}

/** A public id: 8–80 of the safe characters, not a token prefix and not a three-part JWT. */
const PUBLIC_ID = /^[A-Za-z0-9._:@-]{8,80}$/;

export function publicAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!PUBLIC_ID.test(id)) return null;
  if (id.startsWith('sk-') || id.startsWith('sk_')) return null;
  if (id.split('.').length === 3) return null;
  return id;
}

/** Two OS users on one host stay apart. Two machines stay apart. */
export function machineAccountKey(provider: string): string {
  const user = userInfo().username;
  return accountKey(provider, `machine:${user}@${hostname()}:${provider}`);
}

/** Claude: a public id on the credentials body, else a hash of the refresh token, else this machine. */
export function claudeAccountKey(body: unknown): string {
  const row = oauthRow(body);
  if (row) {
    for (const field of ['accountUuid', 'accountId', 'organizationUuid']) {
      const id = publicAccountId(row[field]);
      if (id) return accountKey('claude', `id:${id}`);
    }
    const refresh = typeof row['refreshToken'] === 'string' ? row['refreshToken'].trim() : '';
    if (refresh !== '') return accountKey('claude', `refresh:${refresh}`);
  }
  return machineAccountKey('claude');
}

function oauthRow(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null;
  const oauth = (body as Record<string, unknown>)['claudeAiOauth'];
  if (oauth === null || typeof oauth !== 'object') return null;
  return oauth as Record<string, unknown>;
}

/** Cursor: a public id on the auth file, else this machine. The access token is not hashed. */
export function cursorAccountKey(body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const row = body as Record<string, unknown>;
    for (const field of ['email', 'cachedEmail', 'userId', 'authId']) {
      const id = publicAccountId(row[field]);
      if (id) return accountKey('cursor', `id:${id}`);
    }
  }
  return machineAccountKey('cursor');
}

/** Codex `tokens.account_id`. The raw id is the input, never the key. */
export function openaiAccountKey(accountId: string): string {
  return accountKey('openai', `id:${accountId}`);
}

/** ElevenLabs has no public id. The same API key is the same subscription. */
export function elevenAccountKey(apiKey: string): string {
  return accountKey('elevenlabs', `key:${apiKey}`);
}
