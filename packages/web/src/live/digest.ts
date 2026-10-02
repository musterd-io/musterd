import type { Envelope } from '@musterd/protocol';
import { dayKey } from './format';

/**
 * The team's morning digest (goal dreaming, lane 4) is an ordinary act whose `meta.digest` is an
 * object. `{ day: 'YYYY-MM-DD' }` is what lane 4 posts. The key is checked only for presence, so a
 * digest that later gains more fields still counts.
 */
export function isDigest(e: Pick<Envelope, 'meta'>): boolean {
  const d = e.meta?.digest;
  return typeof d === 'object' && d !== null;
}

/**
 * The digest the Stream pins as its first card: the newest one posted on the viewer's own day,
 * which is the same day the Stream's dividers use. Yesterday's digest is stale by morning, so it
 * goes back to being an ordinary row. The scan runs newest-first and stops once it reaches an
 * earlier day.
 */
export function morningDigest(envelopes: readonly Envelope[], now: number = Date.now()): Envelope | null {
  const today = dayKey(now);
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const e = envelopes[i]!;
    if (dayKey(e.ts) < today) return null;
    if (dayKey(e.ts) === today && isDigest(e)) return e;
  }
  return null;
}

/** The first few non-empty lines of the body, so the pin stays a glance and the row keeps the rest. */
export function digestGlance(body: string, lines = 3): { lines: string[]; more: boolean } {
  const all = body
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .filter(Boolean);
  return { lines: all.slice(0, lines), more: all.length > lines };
}
