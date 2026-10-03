import type { DoorbellRecord } from '@musterd/protocol';
import { postJsonPinned, type SinkResult } from './pinnedPost.js';

/**
 * The generic `webhook` doorbell sink (ADR 443 §3) — the agnostic escape hatch: ntfy, Pushover, an
 * iOS Shortcut, anything that takes a POST. The body is the doorbell record as-is, which by schema
 * carries no message body. One attempt, 5 s abort, never throws; the caller detaches it from the
 * send path and audits `doorbell.surfaced`. The POST resolves the name, refuses a private answer and
 * pins the connection (`pinnedPost.ts`) — the PUT-time literal-host check alone let a public name
 * that resolves to a private address through (ADR 443 §5, closed 2026-10-02).
 */

/** How long we give the endpoint before abandoning the attempt (the send path never waits on it). */
export const WEBHOOK_POST_TIMEOUT_MS = 5_000;

export function postDoorbellWebhook(url: string, record: DoorbellRecord): Promise<SinkResult> {
  return postJsonPinned(url, JSON.stringify(record), WEBHOOK_POST_TIMEOUT_MS);
}
