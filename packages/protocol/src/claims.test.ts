import { describe, expect, it } from 'vitest';
import {
  claimsFromEvidence,
  claimsLine,
  LANE_CLAIMS_MAX,
  LaneClaimsSchema,
  mergeClaims,
  summariseClaims,
  type LaneClaim,
} from './claims.js';

const at = 1_700_000_000_000;

describe('claimsFromEvidence (ADR 585 — the one verdict rule)', () => {
  it('a landed SHA, a deleted branch, a merged PR with green checks', () => {
    const claims = claimsFromEvidence(
      { sha: '9ed67c2', branch: 'feat/x', pr: 2531 },
      {
        ancestry: 'ancestor',
        branch_on_remote: false,
        pr: { merged: true, merge_sha: '9ed67c26a8dbde20f37224cad4ec99affafa77dc' },
        ci_green: true,
      },
      'ryder',
      at,
    );
    expect(claims.map((c) => [c.kind, c.verdict])).toEqual([
      ['commit_landed', 'confirmed'],
      ['branch_pushed', 'unconfirmed'],
      ['pr_merged', 'confirmed'],
      ['ci_green', 'confirmed'],
    ]);
    for (const c of claims) {
      expect(c.checked_by).toBe('ryder');
      expect(c.checked_at).toBe(at);
      expect(LaneClaimsSchema.safeParse([c]).success).toBe(true);
    }
  });

  it('a merged PR whose merge commit is NOT the attested SHA is unconfirmed, not confirmed', () => {
    const [pr] = claimsFromEvidence(
      { sha: 'deadbeef', pr: 1 },
      { ancestry: 'unknown_object', pr: { merged: true, merge_sha: 'abc1234' } },
      'x',
      at,
    ).filter((c) => c.kind === 'pr_merged');
    expect(pr!.verdict).toBe('unconfirmed');
    expect(pr!.evidence).toContain('not the attested SHA');
  });

  it('a checker that could not run records unverifiable, never a guess', () => {
    const claims = claimsFromEvidence(
      { sha: 'abc1234', pr: 7 },
      { ancestry: 'fetch_failed', pr: null, ci_green: null },
      'x',
      at,
    );
    expect(claims.every((c) => c.verdict === 'unverifiable')).toBe(true);
  });

  it('a refuted SHA is unconfirmed', () => {
    const [c] = claimsFromEvidence({ sha: 'abc1234' }, { ancestry: 'not_ancestor' }, 'x', at);
    expect(c!.verdict).toBe('unconfirmed');
  });

  it('files nothing for refs that were not attested', () => {
    expect(claimsFromEvidence({}, {}, 'x', at)).toEqual([]);
  });
});

describe('mergeClaims — two seats, two readings', () => {
  const c = (over: Partial<LaneClaim>): LaneClaim => ({
    kind: 'commit_landed',
    ref: 'abc1234',
    verdict: 'confirmed',
    checked_by: 'ryder',
    checked_at: at,
    ...over,
  });

  it("an acceptor's reading sits beside the submitter's; a seat's re-check replaces its own", () => {
    const standing = [c({}), c({ kind: 'ci_green', ref: '7', verdict: 'unverifiable' })];
    const merged = mergeClaims(standing, [
      c({ checked_by: 'wanderer', verdict: 'confirmed' }),
      c({ kind: 'ci_green', ref: '7', verdict: 'confirmed', checked_at: at + 1 }),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.filter((x) => x.kind === 'commit_landed').map((x) => x.checked_by)).toEqual([
      'ryder',
      'wanderer',
    ]);
    const ci = merged.find((x) => x.kind === 'ci_green')!;
    expect(ci.verdict).toBe('confirmed');
    expect(ci.checked_at).toBe(at + 1);
  });

  it('summarises verdicts and names every checker once', () => {
    const s = summariseClaims([
      c({}),
      c({ checked_by: 'wanderer', verdict: 'unconfirmed' }),
      c({ kind: 'ci_green', verdict: 'unverifiable' }),
    ]);
    expect(s).toEqual({
      confirmed: 1,
      unconfirmed: 1,
      unverifiable: 1,
      checkers: ['ryder', 'wanderer'],
    });
  });

  it('the wire bounds a single filing', () => {
    expect(
      LaneClaimsSchema.safeParse(Array.from({ length: LANE_CLAIMS_MAX + 1 }, () => c({}))).success,
    ).toBe(false);
    expect(LaneClaimsSchema.safeParse([{ ...c({}), kind: 'tests_pass' }]).success).toBe(false);
  });

  it('renders one line', () => {
    expect(
      claimsLine([
        c({}),
        c({ kind: 'pr_merged', verdict: 'unconfirmed' }),
        c({ kind: 'ci_green', verdict: 'unverifiable' }),
      ]),
    ).toBe('commit_landed ✓ · pr_merged ✗ · ci_green ?');
  });
});
