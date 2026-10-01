import type { Seat } from './store.js';

/**
 * Subsequence fuzzy score (higher is better), or null when a term does not match. Space-separated
 * terms must all match, in any order: `rev sta` finds `revive/agents/stanley`. A character at a word
 * start (after `/`, `-`, `@`, a space, or the start) scores more, and so does a run; a shorter text
 * wins a tie.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let total = 0;
  for (const term of terms) {
    const s = termScore(term, hay);
    if (s === null) return null;
    total += s;
  }
  return total - hay.length * 0.01;
}

/**
 * The best greedy match of `term` over every start position of its first character, so `sta` in
 * `revive/agents/stanley` scores the word start `stanley`, not the `s` that ends `agents`.
 */
function termScore(term: string, hay: string): number | null {
  let best: number | null = null;
  for (let start = hay.indexOf(term[0]!); start !== -1; start = hay.indexOf(term[0]!, start + 1)) {
    const s = greedyFrom(term, hay, start);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

function greedyFrom(term: string, hay: string, start: number): number | null {
  let score = 0;
  let from = start;
  let prev = -2;
  for (const ch of term) {
    const at = hay.indexOf(ch, from);
    if (at === -1) return null;
    const boundary = at === 0 || '/-@ '.includes(hay[at - 1]!);
    score += 1 + (boundary ? 3 : 0) + (at === prev + 1 ? 2 : 0);
    prev = at;
    from = at + 1;
  }
  return score;
}

/** Seats matching `query`, best first; ties break on last use (newest first), then address. */
export function rankSeats(
  query: string,
  seats: readonly Seat[],
  lastUsed: (s: Seat) => number | null,
): Seat[] {
  return seats
    .map((seat) => ({ seat, score: fuzzyScore(query, seat.address) }))
    .filter((x): x is { seat: Seat; score: number } => x.score !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (lastUsed(b.seat) ?? 0) - (lastUsed(a.seat) ?? 0) ||
        a.seat.address.localeCompare(b.seat.address),
    )
    .map((x) => x.seat);
}
