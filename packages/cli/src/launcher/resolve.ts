import type { Seat } from './store.js';

export type Resolution =
  | { kind: 'seat'; seat: Seat }
  | { kind: 'ambiguous'; candidates: Seat[] }
  | { kind: 'none'; nearest: string | null };

/**
 * `musterd <word>` → one seat (ADR 491 Decision 2). The caller has already ruled out commands —
 * a command always wins, so this never sees one. Order: `-` (the last launch), an exact address,
 * then a `project/member` suffix or a bare member name.
 */
export function resolveSeatWord(
  word: string,
  seats: readonly Seat[],
  last: string | null,
): Resolution {
  if (word === '-') {
    const seat = last ? seats.find((s) => s.address === last) : undefined;
    return seat ? { kind: 'seat', seat } : { kind: 'none', nearest: null };
  }
  const exact = seats.find((s) => s.address === word);
  if (exact) return { kind: 'seat', seat: exact };
  const matches = word.includes('/')
    ? seats.filter((s) => s.address.endsWith(`/${word}`))
    : seats.filter((s) => s.member === word);
  if (matches.length === 1) return { kind: 'seat', seat: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'none', nearest: nearestMember(word, seats) };
}

function nearestMember(word: string, seats: readonly Seat[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const name of new Set(seats.map((s) => s.member))) {
    const d = editDistance(word, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best !== null && bestDist <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
