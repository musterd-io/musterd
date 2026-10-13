/**
 * Who owns a lane, as the room has seen it (lane 01M4V774MK). The deliver walk's carrier is the lane's
 * owner, but the acceptance ask's sender is not always the owner: a re-routed ask (named, departed or
 * reaped, ADR 545) is minted by whoever re-routed it, and `meta.lane_review` carries no owner. The room
 * already watched the owner claim the card and pin it under "awaiting acceptance", so it remembers them.
 *
 * Bounded: the newest lanes win, so a long-open tab never grows without limit.
 */
const MAX_LANES = 256;

export interface LaneOwners {
  /** The room saw `who` take or pin this lane — they are its owner. */
  note(lane: string, who: string): void;
  /** The lane's owner as the room knows it, else `fallback` (the ask's sender — the pre-fix behavior). */
  carrier(lane: string, fallback: string): string;
}

export function createLaneOwners(): LaneOwners {
  const owners = new Map<string, string>();
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
    carrier(lane, fallback) {
      return owners.get(lane) ?? fallback;
    },
  };
}
