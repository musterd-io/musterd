/**
 * The away relay's validator-free half (ADR 659): protocol version, caps, and the reconcile rule,
 * as plain TypeScript. `relay.ts` builds the zod frames from these constants. The Worker
 * (`workers/away-relay`) carries its own copy of the shapes because it deploys outside the pnpm
 * workspace (ADR 248); the version constant is what the two copies negotiate with.
 */

/** Relay protocol version. A mismatched frame is refused, never reinterpreted. */
export const RELAY_PROTOCOL_VERSION = 1;

/** One frame's maximum serialized size; ask content transits in `deliver` and nowhere else. */
export const RELAY_MAX_FRAME_BYTES = 65_536;

/** Pending metadata rows one team's object may hold (ADR 659 §2). */
export const RELAY_MAX_PENDING = 1_000;

/** The relay's one provider POST attempt times out here; retries are the daemon's decision. */
export const RELAY_PROVIDER_TIMEOUT_MS = 5_000;

/** One pending delivery as the relay stores it: metadata only, never content (ADR 659 §3). */
export interface RelayPendingRow {
  ask_ref: string;
  dedupe_id: string;
  expires_at: number;
}

/**
 * Reconcile (ADR 659 §5): the daemon's live pending set is authoritative. Relay rows absent from
 * it, or past their expiry, are dropped; rows the daemon names survive. Returns the kept and
 * dropped ask refs so both sides can log the same story.
 */
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
