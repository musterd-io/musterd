import { laneCardColumn, type LaneCardPlace } from '@musterd/protocol';

/**
 * ADR 751: where the daemon puts a card when nobody named a place — whenever a card's cell (its goal
 * × its board column) changes, and once for every lane at the v134 backfill.
 *
 * Twelve candidate points, a 4×3 grid inset from the cell's edges. The card takes the candidate
 * farthest from every other card already in the cell, so a cell fills by spreading out, the way a
 * hand pins paper into the emptiest part of a board. Ties go in the candidate order rotated by a hash
 * of the lane id, so two cells don't fill in the same pattern. A pure function of its inputs: the same
 * cell and the same lane land the same place on every daemon.
 */
export const CARD_CANDIDATES: readonly LaneCardPlace[] = [0.2, 0.5, 0.8].flatMap((y) =>
  [0.14, 0.38, 0.62, 0.86].map((x) => ({ x, y })),
);

/** FNV-1a, 32-bit — tie-break order only. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The place for `laneId`'s card in a cell already holding `others`. */
export function pickCardPlace(laneId: string, others: readonly LaneCardPlace[]): LaneCardPlace {
  const n = CARD_CANDIDATES.length;
  const start = hash(laneId) % n;
  let best = CARD_CANDIDATES[start]!;
  let bestGap = -1;
  for (let k = 0; k < n; k++) {
    const c = CARD_CANDIDATES[(start + k) % n]!;
    let gap = Infinity;
    for (const o of others) gap = Math.min(gap, Math.hypot(c.x - o.x, c.y - o.y));
    if (gap > bestGap) {
      best = c;
      bestGap = gap;
    }
  }
  return best;
}

/** The fields of a lane row the backfill reads. */
export interface CardBackfillRow {
  id: string;
  team_id: string;
  goal_id: string | null;
  state: string;
  owner_seat: string | null;
  created_by: string;
  updated_at: number;
}

/**
 * v134 (ADR 751): a card for every lane on the board that has none, placed in `created_at` order —
 * the caller passes the rows sorted that way — so the first board after the upgrade already holds
 * places. Put there by the owner, else the opener; dated to the lane's last update.
 */
export function backfillCards(
  rows: readonly CardBackfillRow[],
): { id: string; card_json: string }[] {
  const cells = new Map<string, LaneCardPlace[]>();
  const out: { id: string; card_json: string }[] = [];
  for (const r of rows) {
    const column = laneCardColumn(r.state);
    if (column === null) continue;
    const key = `${r.team_id}\n${r.goal_id ?? ''}\n${column}`;
    const others = cells.get(key) ?? [];
    const place = pickCardPlace(r.id, others);
    others.push(place);
    cells.set(key, others);
    const card = { ...place, by: r.owner_seat ?? r.created_by, at: r.updated_at };
    out.push({ id: r.id, card_json: JSON.stringify(card) });
  }
  return out;
}
