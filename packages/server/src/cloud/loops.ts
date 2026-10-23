import type { ResolvedConfig } from '../config.js';

/** Every background loop `listen()` can start, by name. */
export const LOOPS = [
  'reaper',
  'seeds_ingest',
  'sync_push',
  'sync_pull',
  'trace_push',
  'footprint',
  'trace_prune',
  'audit_retention',
  'trace_coverage',
  'expired_member_sweep',
  'provision_sweep',
  'roster_watch',
  'digest',
  'policy_review',
  'away_relay',
  'lane_watch',
] as const;
export type LoopName = (typeof LOOPS)[number];

/**
 * Loops that do not run on Cloud (1C task 8; review M4). Each reads or writes THIS MACHINE:
 * - `roster_watch` — projects roster files from local checkouts (ADR 058); Cloud has none.
 * - `footprint` — samples `ps` on the host the daemon runs on; on Cloud that is a Fly VM.
 * - `sync_push` / `sync_pull` / `trace_push` — a federation NODE talking to its hub (ADR 328);
 *   Cloud is the place teams live, never a node of one.
 *
 * `seeds_ingest` was on this list until lane 01M3W815KR. It fetches a relay URL a team's admin sets
 * in policy, which on a multi-tenant fleet any customer could aim at a private or platform-internal
 * address. The pull now goes through `getPinned` (ADR 443 §5's rule: https, resolved and refused
 * unless every answer is global unicast, pinned, no redirect), so it runs on Cloud.
 *
 * `audit_retention` was on this list until lane 01M3W6GWVN. Locally it archives churn rows to a file
 * beside the SQLite store (ADR 478), and a Cloud VM's disk is ephemeral; on Cloud it archives into
 * the `audit_archive` table instead, in the same transaction as the prune (index.ts passes
 * `archiveTable`).
 */
const NOT_ON_CLOUD: ReadonlySet<LoopName> = new Set([
  'roster_watch',
  'footprint',
  'sync_push',
  'sync_pull',
  'trace_push',
  // ADR 659: the relay exists for loopback daemons that cannot take inbound connections. A Cloud
  // server is already public and receives provider callbacks through the shared ingress
  // (away-channels lane 01M50ZQQW9), so it never dials a relay.
  'away_relay',
]);

export function loopsFor(mode: ResolvedConfig['mode']): ReadonlySet<LoopName> {
  return new Set(mode === 'cloud' ? LOOPS.filter((l) => !NOT_ON_CLOUD.has(l)) : LOOPS);
}
