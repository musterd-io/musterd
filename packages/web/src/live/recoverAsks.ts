import type { Envelope, Lane, LaneEvent } from '@musterd/protocol';
import { isAwaitingAcceptance } from '@musterd/protocol/wire';
import { apiGet, fetchHistory, type LiveConfig } from './client';

/**
 * Bring back the review asks a fresh /live load cannot see (lane 01M5G10DB2).
 *
 * **The defect.** The page backfills the newest 200 envelopes and `deriveAsks` is pure over what it
 * holds, so a lane's review ask older than that window never reaches the rail. A lane whose only
 * verdict was a refused human one stays in acceptance for days while its ask scrolls hundreds of
 * envelopes back — exactly the asks `resurrectRefusedVerdicts` exists to re-offer, and it can only
 * re-offer one that is in the timeline. Raising the limit only moves the edge.
 *
 * **The rule.** The board already says which lanes are awaiting acceptance. One the board names no
 * reviewer for (the daemon counts a refused verdict as an answer, ADR 518's `acceptanceWaits`) and
 * whose review ask the timeline does not hold is fetched by its own clock: the lane's history dates
 * the ask (`lane.review_human_asked`, or `lane.ready_for_review` for a single-stage review — each
 * written beside the ask it records), and one forward page from just before that instant holds it.
 * Two small reads per such lane, once per lane id per page load; the derivation stays envelope-pure.
 *
 * Only the asks are recovered, not their verdicts: a lane still awaiting acceptance has no verdict
 * that bound, so its ask reads open. A deferral sent outside the window is the one state lost.
 */

/** How far before the history row the page starts: the row is written just after the ask is routed. */
const LEAD_MS = 60_000;
/** The page size. The ask sits within a few envelopes of its row; this is headroom for a busy minute. */
const PAGE = 200;
const ASKED_ACTIONS = new Set(['lane.review_human_asked', 'lane.ready_for_review']);

function reviewLaneOf(env: Envelope): string | null {
  if (env.act !== 'ask') return null;
  const lane = (env.meta?.['lane_review'] as { lane?: unknown } | undefined)?.lane;
  return typeof lane === 'string' ? lane : null;
}

/** Awaiting lanes with no named reviewer whose review ask the held timeline does not carry. */
export function lanesMissingReviewAsk(lanes: Lane[], envelopes: Envelope[]): string[] {
  const held = new Set<string>();
  for (const e of envelopes) {
    const lane = reviewLaneOf(e);
    if (lane) held.add(lane);
  }
  return lanes
    .filter((l) => isAwaitingAcceptance(l.state) && l.acceptance_reviewer === undefined && !held.has(l.id))
    .map((l) => l.id);
}

/** When the lane's newest review ask went out, from its history; null when it records none. */
export function reviewAskedAt(history: LaneEvent[]): number | null {
  let at: number | null = null;
  for (const h of history) if (ASKED_ACTIONS.has(h.action) && (at === null || h.ts > at)) at = h.ts;
  return at;
}

/** The lane's review asks in a page of history. */
export function reviewAsksIn(page: Envelope[], laneId: string): Envelope[] {
  return page.filter((e) => reviewLaneOf(e) === laneId);
}

/** Fetch one lane's review asks by the date its history gives them. Any failure recovers nothing. */
export async function recoverReviewAsks(cfg: LiveConfig, laneId: string): Promise<Envelope[]> {
  const detail = await apiGet<{ history: LaneEvent[] }>(
    cfg,
    `/teams/${encodeURIComponent(cfg.team)}/lanes/${encodeURIComponent(laneId)}`,
  );
  const at = reviewAskedAt(detail.history);
  if (at === null) return [];
  return reviewAsksIn(await fetchHistory(cfg, { since: at - LEAD_MS, limit: PAGE }), laneId);
}
