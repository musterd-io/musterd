import type { Lane } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, reviewRouting } from './audit.js';
import { ACCEPTANCE_EXEMPT_SAMPLE_RATE, acceptanceExemption } from './review.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * ADR 234 increment 2 — the two halves of the exemption that can be tested without a server: what
 * decides it at submit, and what the close edge can still read about it afterwards.
 *
 * The routing behaviour itself (no ask delivered, the third audit branch, the close reason) is an
 * end-to-end claim and lives in `transport/integration.test.ts`.
 */

const lane = (over: Partial<Lane> = {}): Lane =>
  ({
    id: '01TEST',
    team: 'revive',
    project: 'agents',
    title: 'a lane',
    detail: null,
    owner_seat: 'ada',
    role: null,
    scope: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal',
    merged: null,
    state: 'claimed',
    created_by: 'ada',
    created_at: 0,
    claimed_at: 0,
    resolved_at: null,
    updated_at: 0,
    ...over,
  }) as Lane;

withDrivers('acceptanceExemption', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('acceptanceExemption — only a DECLARATION exempts, and risk outranks it', () => {
    // The draw is stubbed at both extremes throughout: a rule that only holds for one of them is not
    // a rule about stakes, it is a rule about luck.
    const alwaysExempt = () => 0.99; // above the rate ⇒ not sampled in
    const alwaysSampled = () => 0.0; // below the rate ⇒ sampled in, routes anyway

    it('exempts a declared-low lane when the draw misses it', () => {
      expect(acceptanceExemption(lane({ stakes: 'low' }), alwaysExempt)).toEqual({
        exempt: true,
        sampled: false,
      });
    });

    it('routes the 1-in-5 that the draw catches — and says it was sampled, not that it was normal', () => {
      // `sampled: true` with `exempt: false` is the whole point of the hole. If this collapsed to a
      // plain not-exempt, a sampled-in low lane would be indistinguishable in the ledger from a lane
      // declared `normal`, and the sample would produce data nobody could attribute to the low tier.
      expect(acceptanceExemption(lane({ stakes: 'low' }), alwaysSampled)).toEqual({
        exempt: false,
        sampled: true,
      });
    });

    it('never exempts normal or high, at either extreme of the draw', () => {
      for (const stakes of ['normal', 'high'] as const) {
        for (const rand of [alwaysExempt, alwaysSampled]) {
          expect(acceptanceExemption(lane({ stakes }), rand)).toEqual({
            exempt: false,
            sampled: false, // and it is not "sampled in" either — it was never in the sample
          });
        }
      }
    });

    it('a risk tag outranks the declaration — low + risky still routes', () => {
      // ADR 172 makes human review a REQUIREMENT on a risky lane, not a preference. Without this
      // clause `stakes: low` becomes a second, quieter way to clear `risk`, which is precisely the
      // shared-predicate collision ADR 234 §3 built two separate fields to avoid — rebuilt at the
      // consumer instead of at the schema.
      expect(
        acceptanceExemption(lane({ stakes: 'low', risk: ['user_facing'] }), alwaysExempt),
      ).toEqual({ exempt: false, sampled: false });
    });

    it('draws per call, not per lane — the same lane can come out either way', () => {
      // Deriving the draw from the lane id would make each lane permanently exempt or permanently
      // sampled: a fixed subpopulation, not a sample. A lane sent back and resubmitted must get a
      // fresh draw, so the same input has to be able to produce both answers.
      const l = lane({ stakes: 'low' });
      const draws = [0.0, 0.99];
      let i = 0;
      const results = [
        acceptanceExemption(l, () => draws[i++]!),
        acceptanceExemption(l, () => draws[i++]!),
      ];
      expect(results.map((r) => r.exempt)).toEqual([false, true]);
    });

    it('the rate is a real fraction, and the boundary is exclusive', () => {
      expect(ACCEPTANCE_EXEMPT_SAMPLE_RATE).toBeGreaterThan(0);
      expect(ACCEPTANCE_EXEMPT_SAMPLE_RATE).toBeLessThan(1);
      // `rand() < RATE` — a draw exactly ON the rate is NOT sampled. Pinned so the comparison cannot
      // drift to `<=` and quietly change the sampling fraction the Eval divides by.
      expect(
        acceptanceExemption(lane({ stakes: 'low' }), () => ACCEPTANCE_EXEMPT_SAMPLE_RATE).exempt,
      ).toBe(true);
    });
  });

  describe('reviewRouting — an exempt ready row is not a no-candidate one (ADR 234 increment 2)', async () => {
    const seed = async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      return { db, team };
    };
    const ready = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      detail: Record<string, unknown> & { lane: string },
    ) =>
      await appendAudit(db, teamId, {
        actor: 'ada',
        action: 'lane.ready_for_review',
        target: detail.lane,
        result: 'allow',
        detail,
      });

    it('reads a recorded exemption, with routed still false', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'x', acceptance_exempt: true, human_required: false });
      expect(await reviewRouting(db, team.id, 'x')).toEqual({
        routed: false, // literally true: no ask was sent, so every existing consumer stays correct
        exempt: true, // …and this is WHY, which is the part the close edge must not lose
        human_required: false,
        promised_ms: undefined,
      });
    });

    it('abstains on a no-candidate row rather than calling it exempt', async () => {
      // The failure this whole field exists to prevent, from the read side: if `exempt` came back
      // true here, every sanctioned degradation on the fleet would be relabelled as a design choice.
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'y', no_candidate: true, human_required: false });
      const r = await reviewRouting(db, team.id, 'y');
      expect(r.exempt).toBeUndefined();
      expect(r.routed).toBe(false);
    });

    it('abstains on every pre-increment-2 row', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'z', reviewer: 'gee', human_required: false });
      expect((await reviewRouting(db, team.id, 'z')).exempt).toBeUndefined();
      // …and on a lane with no ready row at all.
      expect((await reviewRouting(db, team.id, 'nothing')).exempt).toBeUndefined();
    });

    it('does not accept a truthy non-true value as an exemption', async () => {
      // The `=== true` discipline ADR 173 clause 3 names: a consumer that folds unknown back into
      // truthiness re-creates the defect where it is invisible.
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'w', acceptance_exempt: 'yes' });
      expect((await reviewRouting(db, team.id, 'w')).exempt).toBeUndefined();
    });
  });
});
