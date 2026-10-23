/**
 * The `musterd` block on an APNs payload (ADR 676 §2, the relay's `apnsPayload`).
 *
 * Inline `sealed` is present only when the body fits the push. Otherwise the block carries
 * the route and the phone fetches `GET /app/<team>/body/<binding>/<ref>`. The sealed half is
 * parsed with the protocol's `SealedBodySchema`; the route fields are checked here, at the
 * boundary. This shape is not added to the protocol — the protocol already owns the seal.
 */

import { SealedBodySchema, type SealedBodyWire } from '@musterd/protocol/app-channel';

export interface PushMusterd {
  v: 1;
  team: string;
  binding: string;
  ref: string;
  expires_at: number;
  sealed?: SealedBodyWire;
}

/** The body the relay returns for a fetch-by-ref. The route is this object, not the push. */
export interface FetchedBody {
  team: string;
  binding: string;
  ref: string;
  expires_at: number;
  sealed: SealedBodyWire;
}

export interface PushRoute {
  team: string;
  binding: string;
  ref: string;
  expires_at: number;
}

export function routeOf(block: PushRoute): PushRoute {
  return {
    team: block.team,
    binding: block.binding,
    ref: block.ref,
    expires_at: block.expires_at,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return null;
  return value;
}

function nonnegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function readRoute(block: Record<string, unknown>): PushRoute | null {
  if (block.v !== 1) return null;
  const team = boundedString(block.team, 64);
  const binding = boundedString(block.binding, 64);
  const ref = boundedString(block.ref, 128);
  const expiresAt = nonnegativeInt(block.expires_at);
  if (!team || !binding || !ref || expiresAt === null) return null;
  return { team, binding, ref, expires_at: expiresAt };
}

/**
 * The block off a notification `userInfo`. Accepts either the block itself or the whole
 * payload with the block under `musterd` — the extension hands the app the whole payload.
 * Anything that does not parse is null; the caller shows the generic failure.
 */
export function readPush(userInfo: unknown): PushMusterd | null {
  const record = asRecord(userInfo);
  if (!record) return null;
  const raw = 'musterd' in record ? record.musterd : record;
  const block = asRecord(raw);
  if (!block) return null;
  const route = readRoute(block);
  if (!route) return null;
  if (!('sealed' in block) || block.sealed === undefined) return { v: 1, ...route };
  const sealed = SealedBodySchema.safeParse(block.sealed);
  if (!sealed.success) return null;
  return { v: 1, ...route, sealed: sealed.data };
}

export function readFetchedBody(value: unknown): FetchedBody | null {
  const block = asRecord(value);
  if (!block) return null;
  const route = readRoute({ ...block, v: 1 });
  if (!route) return null;
  const sealed = SealedBodySchema.safeParse(block.sealed);
  if (!sealed.success) return null;
  return { ...route, sealed: sealed.data };
}

export type { SealedBodyWire };
