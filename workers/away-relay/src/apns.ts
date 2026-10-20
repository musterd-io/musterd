/**
 * The relay's push to the musterd app (ADR 676 §9): Apple's token-based APNs, on WebCrypto alone.
 *
 * The provider token is a JWT, ES256, signed with the operator's `.p8` key (`APNS_KEY_P8`, a
 * Worker secret set by the operator, ADR 659 §4) under its key id and the Apple team id. Apple
 * refuses a token older than an hour and one refreshed more often than every twenty minutes, so
 * one token is minted per isolate and reused for fifty minutes, or until APNs calls it expired.
 */

import { RELAY_PROVIDER_TIMEOUT_MS } from './relay.js';

export interface ApnsConfig {
  /** The `.p8` signing key, PEM (PKCS#8). */
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id, which APNs calls the topic. */
  topic: string;
}

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
} as const;

const TOKEN_REUSE_MS = 50 * 60_000;

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Mint one provider token. WebCrypto's ECDSA signature is already JWS's raw r‖s form. */
export async function apnsProviderToken(config: ApnsConfig, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(config.keyP8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signingInput = `${b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))}.${b64url(
    JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }),
  )}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

let cached: { keyId: string; token: string; mintedAt: number } | null = null;

async function bearer(config: ApnsConfig, nowMs: number): Promise<string> {
  if (cached && cached.keyId === config.keyId && nowMs - cached.mintedAt < TOKEN_REUSE_MS)
    return cached.token;
  const token = await apnsProviderToken(config, nowMs);
  cached = { keyId: config.keyId, token, mintedAt: nowMs };
  return token;
}

/** Tests start each case with no cached provider token. */
export function __resetApnsTokenForTest(): void {
  cached = null;
}

export interface ApnsResult {
  ok: boolean;
  status?: number;
  /** `apns-id` on success: the provider coordinate the daemon logs. */
  apnsId?: string;
  /** APNs' stable reason string on failure (`BadDeviceToken`, `Unregistered`, …). */
  reason?: string;
}

/**
 * Send one alert push. The collapse id is the ask ref when it fits Apple's 64 bytes, so a
 * re-delivery of the same ask replaces its notification rather than stacking a second one.
 */
export async function sendApns(
  config: ApnsConfig,
  push: { token: string; environment: 'production' | 'development' },
  input: { body: string; expiresAt: number; collapseId: string },
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ApnsResult> {
  const headers: Record<string, string> = {
    authorization: `bearer ${await bearer(config, nowMs)}`,
    'apns-topic': config.topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(Math.ceil(input.expiresAt / 1000)),
    'content-type': 'application/json',
  };
  if (new TextEncoder().encode(input.collapseId).length <= 64)
    headers['apns-collapse-id'] = input.collapseId;
  let res: Response;
  try {
    res = await fetchImpl(`${APNS_HOSTS[push.environment]}/3/device/${push.token}`, {
      method: 'POST',
      headers,
      body: input.body,
      signal: AbortSignal.timeout(RELAY_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false };
  }
  if (res.ok) {
    const apnsId = res.headers.get('apns-id') ?? undefined;
    return { ok: true, status: res.status, ...(apnsId ? { apnsId } : {}) };
  }
  let reason: string | undefined;
  try {
    const v = (await res.json()) as { reason?: unknown };
    if (typeof v.reason === 'string') reason = v.reason;
  } catch {
    reason = undefined;
  }
  // A token APNs calls expired or invalid is minted afresh on the next push.
  if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') cached = null;
  return { ok: false, status: res.status, ...(reason ? { reason } : {}) };
}

/** The operator's APNs config from the Worker env, or null when any piece is missing. */
export function apnsConfigFrom(env: {
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}): ApnsConfig | null {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return null;
  return {
    keyP8: env.APNS_KEY_P8,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC,
  };
}
