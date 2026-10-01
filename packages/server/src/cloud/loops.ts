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
] as const;
export type LoopName = (typeof LOOPS)[number];

/**
 * Loops that do not run on Cloud (1C task 8; review M4). Most read or write THIS MACHINE:
 * - `roster_watch` — projects roster files from local checkouts (ADR 058); Cloud has none.
 * - `footprint` — samples `ps` on the host the daemon runs on; on Cloud that is a Fly VM.
 * - `sync_push` / `sync_pull` / `trace_push` — a federation NODE talking to its hub (ADR 328);
 *   Cloud is the place teams live, never a node of one.
 * - `audit_retention` — archives churn rows to a file beside the SQLite store (ADR 478) before
 *   pruning; a Cloud VM's disk is ephemeral, and pruning without the archive would lose rows.
 *   Cloud retention arrives with the backup pipeline (spec §7, increment 3).
 *
 * One is about the network instead:
 * - `seeds_ingest` — fetches a relay URL that a team's admin sets in policy, with no public-host
 *   check; on a multi-tenant fleet that is an outbound request any customer can aim at a private or
 *   platform-internal address. It returns once the relay fetch has the webhook's public-host rule.
 */
const NOT_ON_CLOUD: ReadonlySet<LoopName> = new Set([
  'roster_watch',
  'footprint',
  'sync_push',
  'sync_pull',
  'trace_push',
  'audit_retention',
  'seeds_ingest',
]);

export function loopsFor(mode: ResolvedConfig['mode']): ReadonlySet<LoopName> {
  return new Set(mode === 'cloud' ? LOOPS.filter((l) => !NOT_ON_CLOUD.has(l)) : LOOPS);
}
