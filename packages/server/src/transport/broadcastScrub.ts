import { scrubCredentials } from '@musterd/protocol';
import type { MessageVisibility } from '../store/rows.js';

/**
 * ADR 601 decision 3: everything a `broadcast` reader receives is credential-scrubbed on the way
 * out — message bodies, every string in `meta`, roster status lines, lane, goal and report text.
 * One function, `scrubCredentials` (ADR 445), applied to every string leaf of the response for that
 * reader only; stored rows, caches and every other reader are unchanged. A match becomes
 * `<redacted:kind>` and the rest of the text stays (decision 4: what is recognisable, nothing more).
 *
 * Pure and structure-preserving: arrays stay arrays, objects keep their keys, non-strings pass
 * through. A string with no match is returned as the same value, so a body with no secret is
 * byte-identical.
 */
export function scrubForBroadcast<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === 'string') return scrubCredentials(v).text;
  if (Array.isArray(v)) return v.map(walk);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
    return out;
  }
  return v;
}

/** The response a reader of `grade` is served: scrubbed for `broadcast`, the body itself otherwise. */
export function scrubForReader<T>(grade: MessageVisibility, body: T): T {
  return grade === 'broadcast' ? scrubForBroadcast(body) : body;
}
