import { LANE_CLAIMS_MAX, LaneClaimsSchema, type LaneClaim } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { servedClaims } from './lanes.js';

const c = (kind: LaneClaim['kind'], ref: string, by: string, at: number): LaneClaim => ({
  kind,
  ref,
  verdict: 'confirmed',
  checked_by: by,
  checked_at: at,
});

describe('servedClaims (lane 01M5ZFZBCD)', () => {
  it('passes a list within the cap through unchanged', () => {
    const list = [c('commit_landed', 'abc', 'a', 1), c('pr_merged', '12', 'a', 1)];
    expect(servedClaims(list)).toEqual(list);
  });

  it("collapses checkers' duplicate readings to the newest, so the board parses again", () => {
    // revive 01M5ASVF3G: 17 claims, the same kinds and refs confirmed by several seats.
    const seats = ['big-body', 'slippy', 'izzo', 'nick', 'cider'];
    const kinds: LaneClaim['kind'][] = ['commit_landed', 'pr_merged', 'ci_green', 'branch_pushed'];
    const stored = kinds.flatMap((k, i) => seats.map((s, j) => c(k, `ref-${k}`, s, i * 10 + j)));
    expect(stored.length).toBeGreaterThan(LANE_CLAIMS_MAX);
    const served = servedClaims(stored);
    expect(LaneClaimsSchema.safeParse(served).success).toBe(true);
    expect(served).toHaveLength(kinds.length);
    expect(served.every((x) => x.checked_by === 'cider')).toBe(true);
  });

  it('keeps the newest LANE_CLAIMS_MAX when distinct claims alone exceed the cap', () => {
    const stored = Array.from({ length: LANE_CLAIMS_MAX + 4 }, (_, i) =>
      c('ci_green', `check-${i}`, 'a', i),
    );
    const served = servedClaims(stored);
    expect(served).toHaveLength(LANE_CLAIMS_MAX);
    expect(served[0]!.ref).toBe('check-4');
  });
});
