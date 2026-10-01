import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { deriveNext } from './orientation.js';
import { closeVerdicts } from './review.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('closeReason', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * The close REASON on the board projection (ADR 283).
   *
   * ADR 169 taught the projection to say whether a close was accepted; it never taught it to say
   * why an unaccepted one was unaccepted. Both halves of that word are actionable and they point
   * opposite ways: "asked and ignored" sends a seat to chase a person, "nobody was asked" sends it
   * to look at the roster, and nobody is at fault in the second. Measured 2026-08-19 over 344
   * `lane.closed` rows, both already exist in the ledger and neither reaches a reader:
   * `no_candidate` 40 and `acceptance_exempt` 9 against `review_timeout` 23, `review_unanswered` 16,
   * `review_cut_short` 2.
   */

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    await addMember(db, team, { name: 'nick', kind: 'human' });
    await addMember(db, team, { name: 'izzo', kind: 'agent' });
    return { db, team };
  }

  /** A `done` lane owned by izzo, with the `lane.closed` row a close would have written. */
  async function closed(
    db: ReturnType<typeof openDb>,
    teamId: string,
    detail: Record<string, unknown> | null,
    title = 'lane',
  ) {
    const lane = await openLane(db, teamId, 'revive', 'izzo', { title, claim: true });
    await updateLane(db, teamId, lane.id, 'revive', { state: 'done' });
    if (detail !== null) {
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, ?, 'lane.closed', ?, 'allow', ?, ?)`,
        [
          `closed-${lane.id}`,
          teamId,
          Date.now(),
          'izzo',
          lane.id,
          JSON.stringify({ lane: lane.id, ...detail }),
          Date.now(),
        ],
      );
    }
    return lane;
  }

  describe('closeVerdicts — the board projection reads reason alongside verified', async () => {
    it('carries the reason a close recorded, next to its verified-ness', async () => {
      const { db, team } = await seed();
      const lane = await closed(db, team.id, { verified: false, reason: 'no_candidate' });

      const verdicts = await closeVerdicts(db, team.id);
      expect(verdicts.get(lane.id)).toEqual({ verified: false, reason: 'no_candidate' });
    });

    it('separates the two shapes of unconfirmed — the whole point of the field', async () => {
      const { db, team } = await seed();
      // Nobody was ever asked: the roster had no eligible counterpart.
      const unasked = await closed(
        db,
        team.id,
        { verified: false, reason: 'no_candidate' },
        'unasked',
      );
      // Somebody was asked and never answered.
      const ignored = await closed(
        db,
        team.id,
        { verified: false, reason: 'review_timeout' },
        'ignored',
      );

      const verdicts = await closeVerdicts(db, team.id);
      // Both are `verified: false` — indistinguishable before this ADR, and opposite prompts.
      expect(verdicts.get(unasked.id)?.verified).toBe(false);
      expect(verdicts.get(ignored.id)?.verified).toBe(false);
      expect(verdicts.get(unasked.id)?.reason).toBe('no_candidate');
      expect(verdicts.get(ignored.id)?.reason).toBe('review_timeout');
    });

    it('ABSTAINS on a close that recorded no reason — absent, never defaulted', async () => {
      const { db, team } = await seed();
      // A pre-ADR-169 close: verified-ness recorded, reason not. "We do not know" is not "self_close".
      const lane = await closed(db, team.id, { verified: true });

      expect((await closeVerdicts(db, team.id)).get(lane.id)).toEqual({ verified: true });
    });

    it('says nothing at all about a lane with no close row', async () => {
      const { db, team } = await seed();
      const lane = await closed(db, team.id, null);

      expect((await closeVerdicts(db, team.id)).has(lane.id)).toBe(false);
    });

    it('ignores a reason outside the recorded vocabulary rather than passing it through', async () => {
      const { db, team } = await seed();
      // A newer daemon's reason this build has never heard of. The projection is typed; an unknown
      // value must not ride onto the wire as if this build understood it.
      const lane = await closed(db, team.id, {
        verified: false,
        reason: 'invented_by_a_future_build',
      });

      expect((await closeVerdicts(db, team.id)).get(lane.id)).toEqual({ verified: false });
    });

    it('newest close row wins, the same rule verified already followed', async () => {
      const { db, team } = await seed();
      const lane = await closed(db, team.id, { verified: false, reason: 'review_timeout' });
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, ?, 'lane.closed', ?, 'allow', ?, ?)`,
        [
          `reclosed-${lane.id}`,
          team.id,
          Date.now() + 1000,
          'nick',
          lane.id,
          JSON.stringify({ lane: lane.id, verified: true, reason: 'counterpart_confirm' }),
          Date.now() + 1000,
        ],
      );

      expect((await closeVerdicts(db, team.id)).get(lane.id)).toEqual({
        verified: true,
        reason: 'counterpart_confirm',
      });
    });
  });

  describe("deriveNext — the brief says WHY what just shipped wasn't accepted (ADR 283)", async () => {
    it('annotates a shipped lane with its close reason', async () => {
      const { db, team } = await seed();
      const lane = await closed(db, team.id, { verified: false, reason: 'no_candidate' });

      const brief = await deriveNext(db, team.id, 'revive', 'izzo');
      const shipped = brief.shipped.find((l) => l.id === lane.id);
      expect(shipped?.verified).toBe(false);
      expect(shipped?.close_reason).toBe('no_candidate');
    });

    it('leaves a reasonless close un-annotated instead of guessing at it', async () => {
      const { db, team } = await seed();
      const lane = await closed(db, team.id, { verified: true });

      const brief = await deriveNext(db, team.id, 'revive', 'izzo');
      const shipped = brief.shipped.find((l) => l.id === lane.id);
      expect(shipped?.verified).toBe(true);
      expect(shipped?.close_reason).toBeUndefined();
    });
  });
});
