/**
 * The away relay's pure half (ADR 659 §2-§5): frame shapes, caps, the credential comparison and
 * the reconcile rule. This file is the Worker's own copy of the protocol the daemon parses with
 * `@musterd/protocol` (`packages/protocol/src/relay.ts`) — the Worker deploys outside the pnpm
 * workspace (ADR 248), and `RELAY_PROTOCOL_VERSION` is what the two copies negotiate with. No I/O
 * lives here, so every rule is testable in plain vitest.
 */

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_MAX_FRAME_BYTES = 65_536;
export const RELAY_MAX_PENDING = 1_000;
export const RELAY_PROVIDER_TIMEOUT_MS = 5_000;

/**
 * Per-team delivery quota (lane 01M50ZQCTWM5QBZ083782J9N6R, spec scale amendment):
 * every team has its own rate limits, including against Slack's per-workspace send
 * limits. One Durable Object serves one team, so the counters are per-team by
 * construction — one team exhausting its quota cannot spend another's. Defaults sit
 * under Slack's chat.postMessage tiers; the operator may override per team with
 * `TEAM_QUOTAS_JSON` (slug → {per_minute, per_day}).
 */
export const RELAY_DELIVERIES_PER_MINUTE = 60;
export const RELAY_DELIVERIES_PER_DAY = 10_000;

export interface RelayQuota {
  perMinute: number;
  perDay: number;
}

const QUOTA_CEILINGS: RelayQuota = { perMinute: 600, perDay: 100_000 };

function quotaValue(v: unknown, fallback: number, ceiling: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, ceiling) : fallback;
}

/** The quota for one team; a bad or partial map falls back to the defaults, never to unlimited. */
export function quotaForTeam(mapJson: string | undefined, slug: string): RelayQuota {
  const defaults: RelayQuota = {
    perMinute: RELAY_DELIVERIES_PER_MINUTE,
    perDay: RELAY_DELIVERIES_PER_DAY,
  };
  if (!mapJson) return defaults;
  try {
    const v: unknown = JSON.parse(mapJson);
    if (!isRecord(v) || !isRecord(v[slug])) return defaults;
    const entry = v[slug];
    return {
      perMinute: quotaValue(entry['per_minute'], defaults.perMinute, QUOTA_CEILINGS.perMinute),
      perDay: quotaValue(entry['per_day'], defaults.perDay, QUOTA_CEILINGS.perDay),
    };
  } catch {
    return defaults;
  }
}

/**
 * May this team make one more provider delivery now? Counts are of actual provider
 * attempts in the trailing windows, taken by the team's own object — a duplicate
 * frame is answered from its stored row and never reaches this check.
 */
export function quotaVerdict(
  lastMinuteAttempts: number,
  lastDayAttempts: number,
  quota: RelayQuota,
): 'ok' | 'rate_limited' | 'quota_exceeded' {
  if (lastDayAttempts >= quota.perDay) return 'quota_exceeded';
  if (lastMinuteAttempts >= quota.perMinute) return 'rate_limited';
  return 'ok';
}

export interface RelayPendingRow {
  ask_ref: string;
  dedupe_id: string;
  expires_at: number;
}

/** One Slack install record held for a daemon (ADR 668 decision 2, increment 9). */
export interface RelaySlackInstall {
  slack_team_id: string;
  bot_token: string;
  installer_slack_id: string;
  state: string;
  installed_at: number;
}

export type DaemonFrame =
  | { protocol: 1; type: 'install_sync' }
  | { protocol: 1; type: 'install_ack'; slack_team_ids: string[] }
  | { protocol: 1; type: 'reconcile'; pending: RelayPendingRow[] }
  | {
      protocol: 1;
      type: 'deliver';
      ask_ref: string;
      dedupe_id: string;
      expires_at: number;
      post: { url: string; body: string; headers?: Record<string, string> };
    }
  | {
      protocol: 1;
      type: 'app_deliver';
      ask_ref: string;
      dedupe_id: string;
      expires_at: number;
      binding: string;
      push: AppPushTarget;
      sealed: SealedBody;
    }
  | {
      protocol: 1;
      type: 'app_body';
      request_id: string;
      sealed: SealedBody | null;
      expires_at?: number;
    }
  | { protocol: 1; type: 'resolve'; ask_ref: string };

/** A sealed body as the daemon sends it (ADR 676 §2): opaque to the relay, base64url fields. */
export interface SealedBody {
  v: 1;
  enc: string;
  ct: string;
}

/** Where one app delivery is pushed: the binding's APNs device token and environment. */
export interface AppPushTarget {
  token: string;
  environment: 'production' | 'development';
}

/** At or under this many bytes of sealed body the push carries it; over it, the ask ref only. */
export const APP_PUSH_INLINE_MAX_BYTES = 3_072;
/** APNs' payload ceiling for an alert push. */
export const APNS_MAX_PAYLOAD_BYTES = 4_096;

const B64URL = /^[A-Za-z0-9_-]+$/;

function isSealed(v: unknown): v is SealedBody {
  return (
    isRecord(v) &&
    v['v'] === 1 &&
    typeof v['enc'] === 'string' &&
    v['enc'].length <= 256 &&
    B64URL.test(v['enc']) &&
    typeof v['ct'] === 'string' &&
    v['ct'].length <= 65_536 &&
    B64URL.test(v['ct'])
  );
}

function isPushTarget(v: unknown): v is AppPushTarget {
  return (
    isRecord(v) &&
    typeof v['token'] === 'string' &&
    /^[0-9a-f]{64,200}$/.test(v['token']) &&
    (v['environment'] === 'production' || v['environment'] === 'development')
  );
}

/** The bytes a sealed body takes in a push: its two encoded fields, as sent. */
export function sealedPushBytes(sealed: SealedBody): number {
  return sealed.enc.length + sealed.ct.length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPending(v: unknown): v is RelayPendingRow {
  return (
    isRecord(v) &&
    typeof v['ask_ref'] === 'string' &&
    v['ask_ref'].length > 0 &&
    typeof v['dedupe_id'] === 'string' &&
    v['dedupe_id'].length > 0 &&
    typeof v['expires_at'] === 'number' &&
    Number.isInteger(v['expires_at']) &&
    v['expires_at'] >= 0
  );
}

/** Parse one daemon frame at the boundary; a malformed or oversized frame is refused, never guessed. */
export function parseDaemonFrame(raw: string): DaemonFrame | null {
  if (new TextEncoder().encode(raw).length > RELAY_MAX_FRAME_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v['protocol'] !== RELAY_PROTOCOL_VERSION) return null;
  if (v['type'] === 'install_sync') return { protocol: 1, type: 'install_sync' };
  if (v['type'] === 'install_ack') {
    if (
      !Array.isArray(v['slack_team_ids']) ||
      v['slack_team_ids'].length > 32 ||
      !v['slack_team_ids'].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
    )
      return null;
    return { protocol: 1, type: 'install_ack', slack_team_ids: v['slack_team_ids'] as string[] };
  }
  if (v['type'] === 'reconcile') {
    if (!Array.isArray(v['pending']) || !v['pending'].every(isPending)) return null;
    if (v['pending'].length > RELAY_MAX_PENDING) return null;
    return { protocol: 1, type: 'reconcile', pending: v['pending'] };
  }
  if (v['type'] === 'deliver') {
    if (typeof v['ask_ref'] !== 'string' || v['ask_ref'].length === 0) return null;
    if (typeof v['dedupe_id'] !== 'string' || v['dedupe_id'].length === 0) return null;
    if (typeof v['expires_at'] !== 'number' || !Number.isInteger(v['expires_at'])) return null;
    const post = v['post'];
    if (!isRecord(post) || typeof post['url'] !== 'string' || typeof post['body'] !== 'string')
      return null;
    try {
      new URL(post['url']);
    } catch {
      return null;
    }
    const headers = post['headers'];
    if (
      headers !== undefined &&
      (!isRecord(headers) || !Object.values(headers).every((h) => typeof h === 'string'))
    )
      return null;
    return {
      protocol: 1,
      type: 'deliver',
      ask_ref: v['ask_ref'],
      dedupe_id: v['dedupe_id'],
      expires_at: v['expires_at'],
      post: {
        url: post['url'],
        body: post['body'],
        ...(headers ? { headers: headers as Record<string, string> } : {}),
      },
    };
  }
  if (v['type'] === 'app_deliver') {
    if (typeof v['ask_ref'] !== 'string' || v['ask_ref'].length === 0) return null;
    if (typeof v['dedupe_id'] !== 'string' || v['dedupe_id'].length === 0) return null;
    if (typeof v['expires_at'] !== 'number' || !Number.isInteger(v['expires_at'])) return null;
    if (typeof v['binding'] !== 'string' || v['binding'].length === 0 || v['binding'].length > 64)
      return null;
    if (!isPushTarget(v['push']) || !isSealed(v['sealed'])) return null;
    return {
      protocol: 1,
      type: 'app_deliver',
      ask_ref: v['ask_ref'],
      dedupe_id: v['dedupe_id'],
      expires_at: v['expires_at'],
      binding: v['binding'],
      push: { token: v['push'].token, environment: v['push'].environment },
      sealed: { v: 1, enc: v['sealed'].enc, ct: v['sealed'].ct },
    };
  }
  if (v['type'] === 'app_body') {
    if (typeof v['request_id'] !== 'string' || v['request_id'].length === 0) return null;
    const sealed = v['sealed'];
    if (sealed !== null && !isSealed(sealed)) return null;
    const expires = v['expires_at'];
    if (expires !== undefined && (typeof expires !== 'number' || !Number.isInteger(expires)))
      return null;
    return {
      protocol: 1,
      type: 'app_body',
      request_id: v['request_id'],
      sealed: sealed === null ? null : { v: 1, enc: sealed.enc, ct: sealed.ct },
      ...(expires !== undefined ? { expires_at: expires } : {}),
    };
  }
  if (v['type'] === 'resolve') {
    if (typeof v['ask_ref'] !== 'string' || v['ask_ref'].length === 0) return null;
    return { protocol: 1, type: 'resolve', ask_ref: v['ask_ref'] };
  }
  return null;
}

/**
 * The app's callback (ADR 676 §6, §8), checked for shape only: the daemon parses it in full and
 * its trust is the seal and the phone's signature, never this relay. Returns the ref the callback
 * frame carries — the pairing or ask it names, or the binding for a re-delivery — or null.
 */
export function appCallbackRef(raw: string): string | null {
  if (new TextEncoder().encode(raw).length > RELAY_MAX_FRAME_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v['app'] !== 1) return null;
  const binding = v['binding'];
  if (typeof binding !== 'string' || binding.length === 0 || binding.length > 64) return null;
  if (v['kind'] === 'redeliver') return binding;
  if (v['kind'] !== 'pair' && v['kind'] !== 'answer') return null;
  const ref = v['ref'];
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 128) return null;
  if (!isSealed(v['sealed'])) return null;
  return ref;
}

/**
 * The APNs request body for one app delivery (ADR 676 §9). The alert text is the relay's own
 * fixed placeholder; the notification service extension replaces it with the opened ask. The
 * `musterd` block carries the route the seal was made under — what the phone opens with — and
 * the sealed body only when it fits; otherwise the phone fetches it by ref.
 */
export function apnsPayload(
  slug: string,
  frame: Extract<DaemonFrame, { type: 'app_deliver' }>,
): { body: string; inline: boolean } {
  const build = (inline: boolean) =>
    JSON.stringify({
      aps: {
        alert: { title: 'musterd', body: 'An ask is waiting for you.' },
        sound: 'default',
        'mutable-content': 1,
        'interruption-level': 'time-sensitive',
      },
      musterd: {
        v: 1,
        team: slug,
        binding: frame.binding,
        ref: frame.ask_ref,
        expires_at: frame.expires_at,
        ...(inline ? { sealed: frame.sealed } : {}),
      },
    });
  if (sealedPushBytes(frame.sealed) <= APP_PUSH_INLINE_MAX_BYTES) {
    const body = build(true);
    if (new TextEncoder().encode(body).length <= APNS_MAX_PAYLOAD_BYTES)
      return { body, inline: true };
  }
  return { body: build(false), inline: false };
}

/** Reconcile (ADR 659 §5): the daemon's live pending set is authoritative; the rest is dropped. */
export function reconcileRelayPending(
  relayRows: readonly RelayPendingRow[],
  daemonPending: readonly RelayPendingRow[],
  now: number,
): { kept: string[]; dropped: string[] } {
  const live = new Set(daemonPending.filter((r) => r.expires_at > now).map((r) => r.ask_ref));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const row of relayRows) {
    if (row.expires_at > now && live.has(row.ask_ref)) kept.push(row.ask_ref);
    else dropped.push(row.ask_ref);
  }
  return { kept, dropped };
}

/**
 * May this `deliver` be stored? A duplicate dedupe id is the same delivery, not a second one —
 * except when the stored attempt `failed`: a failed delivery is never "delivered", so the
 * daemon's re-push (ADR 659 §2: a retry is the daemon's decision, re-pushed) re-sends it instead
 * of being answered with the stored failure forever.
 */
export function deliverVerdict(
  existingStatus: string | null,
  pendingCount: number,
  expiresAt: number,
  now: number,
): 'store' | 'retry' | 'duplicate' | 'expired' | 'full' {
  if (existingStatus === 'failed') return expiresAt <= now ? 'expired' : 'retry';
  if (existingStatus !== null) return 'duplicate';
  if (expiresAt <= now) return 'expired';
  if (pendingCount >= RELAY_MAX_PENDING) return 'full';
  return 'store';
}

/**
 * The second-socket rule (ADR 659 §1, amended 2026-10-19): a second socket presenting the
 * credential the live socket already holds is refused. A socket presenting the operator map's
 * CURRENT credential while the live socket holds a different (rotated-away) one replaces it —
 * that is the §4 rotation path, and refusing it would lock the daemon out until the stale
 * socket happens to die.
 */
export function secondSocketVerdict(
  liveCredentialHash: string | null,
  presentedCredentialHash: string | null,
  expectedCredentialHash: string | null,
): 'refuse' | 'replace' {
  if (
    presentedCredentialHash !== null &&
    expectedCredentialHash !== null &&
    hashesEqual(presentedCredentialHash, expectedCredentialHash) &&
    liveCredentialHash !== presentedCredentialHash
  )
    return 'replace';
  return 'refuse';
}

/**
 * Rotation/revocation on a live socket (ADR 659 §4): the credential hash the socket presented
 * at upgrade is re-checked against the operator map on every frame. Once the map names a
 * different hash (rotation) or none (revocation), the socket's next frame is refused.
 */
export function socketCredentialLive(
  presentedCredentialHash: string | null,
  expectedCredentialHash: string | null,
): boolean {
  return (
    presentedCredentialHash !== null &&
    expectedCredentialHash !== null &&
    hashesEqual(presentedCredentialHash, expectedCredentialHash)
  );
}

/** Provider coordinates from a provider's JSON answer (Slack: `channel` + `ts`); opaque elsewhere. */
export function providerRefFrom(responseBody: string): string | undefined {
  try {
    const v: unknown = JSON.parse(responseBody);
    if (!isRecord(v)) return undefined;
    const channel = v['channel'];
    const ts = v['ts'];
    if (typeof channel === 'string' && typeof ts === 'string') return `${channel}:${ts}`;
    if (typeof ts === 'string') return ts;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Parse the operator's `TEAM_CREDENTIALS_JSON` (slug → sha256 hex). A bad map authenticates nobody. */
export function credentialHashFor(mapJson: string | undefined, slug: string): string | null {
  if (!mapJson) return null;
  try {
    const v: unknown = JSON.parse(mapJson);
    if (!isRecord(v)) return null;
    const hash = v[slug];
    return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Slack's team id from an interactivity body (`payload=<urlencoded JSON>`); null when absent. */
export function slackTeamIdFromBody(rawBody: string): string | null {
  try {
    const payload = new URLSearchParams(rawBody).get('payload');
    if (!payload) return null;
    const v: unknown = JSON.parse(payload);
    if (!isRecord(v) || !isRecord(v['team'])) return null;
    const id = v['team']['id'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The operator's install mapping (Slack team id → musterd team slug); null when unmapped. */
export function slackMappedSlug(mapJson: string | undefined, slackTeamId: string): string | null {
  if (!mapJson) return null;
  try {
    const v: unknown = JSON.parse(mapJson);
    if (!isRecord(v)) return null;
    const slug = v[slackTeamId];
    return typeof slug === 'string' && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

/**
 * Dispatch is by the install mapping, never by the caller (ADR 668 §2): a callback is
 * forwarded only when the payload's Slack team maps to the slug named in the URL. No request
 * field can select a different destination.
 */
export function slackDispatchAllowed(
  payloadTeamId: string | null,
  mapJson: string | undefined,
  urlSlug: string,
): boolean {
  if (!payloadTeamId) return false;
  return slackMappedSlug(mapJson, payloadTeamId) === urlSlug;
}

/**
 * Verify Slack's signature (ADR 668 §1): `v0=` + HMAC-SHA256 over `v0:<timestamp>:<raw body>`
 * with the signing secret, inside a five-minute timestamp tolerance. The comparison runs over
 * hex digests with the constant-time rule above.
 */
export async function slackSignatureValid(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowMs: number,
): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
  if (!signature.startsWith('v0=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hashesEqual(hex, signature.slice(3));
}

/** Constant-time comparison of two hex digests (both sides are hashed before this is called). */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
