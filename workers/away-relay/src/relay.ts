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

export interface RelayPendingRow {
  ask_ref: string;
  dedupe_id: string;
  expires_at: number;
}

export type DaemonFrame =
  | { protocol: 1; type: 'reconcile'; pending: RelayPendingRow[] }
  | {
      protocol: 1;
      type: 'deliver';
      ask_ref: string;
      dedupe_id: string;
      expires_at: number;
      post: { url: string; body: string; headers?: Record<string, string> };
    }
  | { protocol: 1; type: 'resolve'; ask_ref: string };

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
  if (v['type'] === 'resolve') {
    if (typeof v['ask_ref'] !== 'string' || v['ask_ref'].length === 0) return null;
    return { protocol: 1, type: 'resolve', ask_ref: v['ask_ref'] };
  }
  return null;
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
