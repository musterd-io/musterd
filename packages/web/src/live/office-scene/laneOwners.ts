/**
 * Who owns a lane, as the room has seen it (lane 01M4V774MK). The deliver walk's carrier is the lane's
 * owner, but the acceptance ask's sender is not always the owner: a re-routed ask (named, departed or
 * reaped, ADR 545) is minted by whoever re-routed it, and `meta.lane_review` carries no owner. The room
 * already watched the owner claim the card and pin it under "awaiting acceptance", so it remembers them.
 *
 * Two layers (lane 01M50TZDDM): the board's `owner_seat` is the base, so a lane claimed before the
 * viewer arrived still has its owner. A board refresh is newer than anything the room watched before
 * it, so it clears those notes; a walk watched AFTER the refresh wins until the next one, because the
 * board has not caught up with it yet.
 *
 * Bounded: the newest lanes win, so a long-open tab never grows without limit.
 */
const MAX_LANES = 256;

export interface LaneOwners {
  /** The room saw `who` take or pin this lane — they are its owner. */
  note(lane: string, who: string): void;
  /** The board changed: lane → `owner_seat` for every owned lane it lists. Replaces the last seed and
   *  drops what the room watched before it. */
  seed(board: ReadonlyMap<string, string>): void;
  /** The lane's owner as the room knows it, else `fallback` (the ask's sender — the pre-fix behavior). */
  carrier(lane: string, fallback: string): string;
  /** `who` resolved the lane and is NOT its known owner — an acceptance, not a self-close. A lane the
   *  room never saw owned counts as accepted: the flourish costs a puff of paper if that is wrong. */
  closedByOther(lane: string, who: string): boolean;
}

export function createLaneOwners(): LaneOwners {
  const owners = new Map<string, string>();
  let board: ReadonlyMap<string, string> = new Map();
  const ownerOf = (lane: string): string | undefined => owners.get(lane) ?? board.get(lane);
  return {
    note(lane, who) {
      // Delete first so a re-noted lane moves to the newest end and eviction drops the stalest.
      owners.delete(lane);
      owners.set(lane, who);
      if (owners.size > MAX_LANES) {
        const oldest = owners.keys().next().value;
        if (oldest !== undefined) owners.delete(oldest);
      }
    },
    seed(next) {
      board = next;
      owners.clear();
    },
    carrier(lane, fallback) {
      return ownerOf(lane) ?? fallback;
    },
    closedByOther(lane, who) {
      return ownerOf(lane) !== who;
    },
  };
}
