import type { Envelope, MemberSummary } from '@musterd/protocol';
import { memberPosture } from './format';

/**
 * The top bar's busyness meter (ADR 464, spec §5): how alive the team is right now, from what the
 * page already holds. Three facts, none inferred: how long since the last act, how many acts over
 * the loaded span (bucketed for a sparkline), and who is working / between tasks / away.
 *
 * The envelope buffer is capped (#328), so the loaded span is whatever the page has — the meter
 * names that span and never extrapolates a rate from a slice: under an hour it says "last 40 min"
 * and counts acts; at an hour or more it says "/hr" over the hours it can see.
 */
export interface Busyness {
  /** ms since the newest envelope, or null with nothing loaded. */
  lastActAgeMs: number | null;
  /** Acts per bucket, oldest first — the sparkline's bars. */
  buckets: number[];
  /** "20/hr" once an hour or more is loaded; "3 acts" under that. */
  rateLabel: string;
  /** "last 3h" / "last 40 min" — the span the rate and bars cover. */
  spanLabel: string;
  counts: { working: number; between: number; away: number; humans: number; present: number };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 15-minute bars: an hour reads as four, a day as ninety-six (the buffer never holds a day). */
const BUCKET_MS = 15 * MIN;

export function busyness(
  envelopes: readonly Envelope[],
  roster: readonly MemberSummary[],
  now: number,
): Busyness {
  const counts = { working: 0, between: 0, away: 0, humans: 0, present: 0 };
  for (const m of roster) {
    if (m.presence === 'offline') continue;
    counts.present += 1;
    if (m.kind === 'human') counts.humans += 1;
    const p = memberPosture(m);
    if (p === 'working') counts.working += 1;
    else if (p === 'away') counts.away += 1;
    else counts.between += 1;
  }
  if (envelopes.length === 0) {
    return {
      lastActAgeMs: null,
      buckets: [],
      rateLabel: '0 acts',
      spanLabel: 'nothing loaded',
      counts,
    };
  }
  let newest = -Infinity;
  let oldest = Infinity;
  for (const e of envelopes) {
    if (e.ts > newest) newest = e.ts;
    if (e.ts < oldest) oldest = e.ts;
  }
  const span = Math.max(now - oldest, MIN);
  const nBuckets = Math.max(1, Math.ceil(span / BUCKET_MS));
  const buckets = new Array<number>(nBuckets).fill(0);
  for (const e of envelopes) {
    const i = Math.min(nBuckets - 1, Math.max(0, Math.floor((e.ts - oldest) / BUCKET_MS)));
    buckets[i] = (buckets[i] ?? 0) + 1;
  }
  const hours = span / HOUR;
  const rateLabel =
    hours >= 1
      ? `${Math.round(envelopes.length / hours)}/hr`
      : `${envelopes.length} act${envelopes.length === 1 ? '' : 's'}`;
  const spanLabel =
    hours >= 1 ? `last ${Math.round(hours)}h` : `last ${Math.max(1, Math.round(span / MIN))} min`;
  return { lastActAgeMs: Math.max(0, now - newest), buckets, rateLabel, spanLabel, counts };
}

/** "last act 3s ago" — coarse on purpose; the dot beside it is the live signal. */
export function lastActLabel(ageMs: number | null): string {
  if (ageMs === null) return 'no acts yet';
  if (ageMs < 1_000) return 'last act just now';
  if (ageMs < MIN) return `last act ${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < HOUR) return `last act ${Math.floor(ageMs / MIN)}m ago`;
  return `last act ${Math.floor(ageMs / HOUR)}h ago`;
}
