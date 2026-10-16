/**
 * Per-team request budget (ADR 622, cloud design §5.4).
 *
 * The key is the team slug. On Cloud every request arrives from the edge, so a peer-IP key is one
 * bucket for every team, or a bucket a caller can rotate. HTTP charges the path team and a
 * WebSocket upgrade charges the host team. They share this map. A global route has no team and is
 * not charged.
 *
 * The check is synchronous. A denial records no hit, so the caller can answer before it checks a
 * client out of the shared pool.
 */

/** Requests admitted per team per window when `MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN` is unset. */
export const CLOUD_TEAM_BUDGET_PER_MIN = 600;

export const TEAM_BUDGET_WINDOW_MS = 60_000;

/** Distinct slugs are unbounded. The map is not. Same cap as the OAuth buckets (ADR 446). */
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
 * True when this request is inside the team's window. A denial prunes expired hits and records
 * nothing new.
 */
export function takeTeamRequest(team: string, limit: number, now = Date.now()): boolean {
  const key = team.toLowerCase();
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
