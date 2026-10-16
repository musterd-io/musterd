import type { IncomingMessage } from 'node:http';
import { ClientAddressSchema } from '@musterd/protocol';

/** Cloud admission per (team, client address), shared by HTTP and WS (ADR 634). */
/** Requests admitted per team and client per window when `MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN` is unset. */
export const CLOUD_TEAM_BUDGET_PER_MIN = 600;

export const TEAM_BUDGET_WINDOW_MS = 60_000;

/** Distinct team/client pairs are unbounded. The map is not. Same cap as the OAuth buckets (ADR 446). */
export const TEAM_BUDGET_MAX_KEYS = 10_000;

/** No slug: the path is attacker-controlled and may itself be credential-shaped. */
export const TEAM_BUDGET_MESSAGE = 'too many requests for this team — retry in a minute';

const buckets = new Map<string, number[]>();

/** Test seam: empty the windows between cases. One map for the process. */
export function __resetTeamBudgetForTest(): void {
  buckets.clear();
}

/** Test seam: current key cardinality. */
export function __teamBudgetSizeForTest(): number {
  return buckets.size;
}

/**
 * True when this request is inside the team/client window. A denial prunes expired hits and records
 * nothing new.
 */
export function takeTeamRequest(
  team: string,
  client: string,
  limit: number,
  now = Date.now(),
): boolean {
  const key = JSON.stringify([team.toLowerCase(), client]);
  const windowStart = now - TEAM_BUDGET_WINDOW_MS;
  const prev = buckets.get(key) ?? [];
  const hits = prev.filter((t) => t > windowStart);
  if (hits.length >= limit) {
    if (hits.length !== prev.length) buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > TEAM_BUDGET_MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t <= windowStart)) buckets.delete(k);
      if (buckets.size <= TEAM_BUDGET_MAX_KEYS) break;
    }
    for (const k of buckets.keys()) {
      if (buckets.size <= TEAM_BUDGET_MAX_KEYS) break;
      buckets.delete(k);
    }
  }
  return true;
}

/**
 * Cloudflare overwrites CF-Connecting-IP. Trust it only in the configured proxy posture, which
 * requires an origin reachable only through that proxy and no Worker rewriting this header.
 * Never trust X-Forwarded-For. Missing/malformed metadata falls back to the peer, grouping such
 * requests conservatively. Addresses select counters only: no authorization and no logging.
 */
export function requestBudgetClient(req: IncomingMessage, trustProxy: boolean): string {
  const edge = trustProxy ? req.headers['cf-connecting-ip'] : undefined;
  const parsed = ClientAddressSchema.safeParse(typeof edge === 'string' ? edge.trim() : undefined);
  const address = parsed.success ? parsed.data : req.socket.remoteAddress;
  const peer = ClientAddressSchema.safeParse(address);
  if (!peer.success) return 'unknown';
  // URL canonicalizes equivalent IPv6 spellings; IPv4 is already canonical after schema parsing.
  return peer.data.includes(':') ? new URL(`http://[${peer.data}]/`).hostname : peer.data;
}
