import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { digestGlance, isDigest, morningDigest } from './digest';

const NOW = new Date(2026, 9, 2, 11, 5).getTime(); // a Friday, 11:05 local
const HOUR = 3_600_000;

const env = (id: string, ts: number, meta: Record<string, unknown> | null = null): Envelope =>
  ({ id, v: 1, team: 'revive', from: 'ghost', to: '@team', act: 'message', body: '', meta, ts }) as unknown as Envelope;

describe('isDigest', () => {
  it('is the meta.digest object, and nothing else', () => {
    expect(isDigest(env('a', NOW, { digest: { day: '2026-10-02' } }))).toBe(true);
    expect(isDigest(env('b', NOW, { digest: true }))).toBe(false);
    expect(isDigest(env('c', NOW, null))).toBe(false);
  });
});

describe('morningDigest — the first card in the Stream', () => {
  const digest = { digest: { day: '2026-10-02' } };

  it("pins today's digest", () => {
    const rows = [env('d', NOW - 2 * HOUR, digest), env('x', NOW - HOUR)];
    expect(morningDigest(rows, NOW)?.id).toBe('d');
  });

  it('pins the newest when the digest was re-posted', () => {
    const rows = [env('d1', NOW - 3 * HOUR, digest), env('d2', NOW - HOUR, digest)];
    expect(morningDigest(rows, NOW)?.id).toBe('d2');
  });

  // Yesterday's digest is history by this morning: an ordinary row, not a pin.
  it("does not pin yesterday's digest", () => {
    expect(morningDigest([env('y', NOW - 24 * HOUR, digest)], NOW)).toBeNull();
  });

  it('is null on a quiet stream', () => {
    expect(morningDigest([], NOW)).toBeNull();
  });
});

describe('digestGlance', () => {
  it('keeps three readable lines without the markdown marks, and says when there is more', () => {
    const g = digestGlance('## Learned\n- the wake cap is 6/h\n\n- pglite needs a reset\n## Waiting\n- PR #1955');
    expect(g.lines).toEqual(['Learned', 'the wake cap is 6/h', 'pglite needs a reset']);
    expect(g.more).toBe(true);
  });
});
