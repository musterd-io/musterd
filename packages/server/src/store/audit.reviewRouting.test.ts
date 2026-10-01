import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, reviewRouting, standingAcceptance } from './audit.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('audit.reviewRouting', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * `reviewRouting`'s read edge (ADR 173 correction #1). The function that motivated ADR 173 violated
   * its clause 1 in its own return type: `routed` abstained, `human_required` beside it did not — it
   * read `false` both for a legacy row predating #462 (the field was never written) and for a
   * `catch`-ed parse failure. "Could not see whether a human was required" was served as "no human was
   * required", and the close edge's ADR 172 counter-metric undercounted over exactly those rows.
   *
   * The write edge was never wrong (`lane.risk.length > 0`, a closed set the writer owns), so these
   * cases are all about what the READ says when the evidence is absent or unreadable.
   */
  describe('reviewRouting — human_required abstains rather than asserting a negative (ADR 173)', async () => {
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
        target: detail.lane, // the ready edge writes the lane id as the audit target
        result: 'allow',
        detail,
      });

    it('reads a recorded requirement straight through, both ways', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'a', reviewer: 'gee', human_required: true });
      await ready(db, team.id, { lane: 'b', reviewer: 'gee', human_required: false });
      expect(await reviewRouting(db, team.id, 'a')).toEqual({
        routed: true,
        human_required: true,
        promised_ms: undefined,
      });
      // An explicit false is knowledge, not absence — it must NOT become undefined.
      expect(await reviewRouting(db, team.id, 'b')).toEqual({
        routed: true,
        human_required: false,
        promised_ms: undefined,
      });
    });

    it('abstains on a legacy row that predates the field (#462), rather than reading "not required"', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'a', reviewer: 'gee' }); // routed, but human_required never written
      expect(await reviewRouting(db, team.id, 'a')).toEqual({
        routed: true,
        human_required: undefined,
        promised_ms: undefined,
      });
    });

    // The `catch` was unreachable and the real behavior was worse than the lane reported: the WHERE
    // clause filtered on `json_extract(detail, '$.lane')`, so SQLite raised "malformed JSON" from the
    // QUERY, before the try — a throw out of the function, not an abstention.
    it('abstains — never throws — when the row exists but its detail will not parse', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'a', reviewer: 'gee', human_required: true });
      await db.run(`UPDATE audit SET detail = '{not json'`);
      await expect(reviewRouting(db, team.id, 'a')).resolves.not.toBeNull();
      expect(await reviewRouting(db, team.id, 'a')).toEqual({
        routed: undefined,
        human_required: undefined,
        promised_ms: undefined,
      });
    });

    // …and the blast radius was every lane, not just the corrupt one: json_extract was evaluated over
    // every `lane.ready_for_review` row the scan touched, so ONE unparseable row broke the close edge
    // for lanes whose own rows were perfectly fine.
    it('one unparseable row does not poison the lookup for a different, healthy lane', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'bad', reviewer: 'gee' });
      await ready(db, team.id, { lane: 'good', reviewer: 'gee', human_required: true });
      await db.run(`UPDATE audit SET detail = '{not json' WHERE target = 'bad'`);
      expect(await reviewRouting(db, team.id, 'good')).toEqual({
        routed: true,
        human_required: true,
        promised_ms: undefined,
      });
    });

    it('abstains when there is no ready row at all', async () => {
      const { db, team } = await seed();
      expect(await reviewRouting(db, team.id, 'never-ready')).toEqual({
        routed: undefined,
        human_required: undefined,
        promised_ms: undefined,
      });
    });

    // The post-#450, pre-#462 window is the row shape that makes this more than a type change: it
    // recorded the routing outcome but not the requirement, so it lands on the reason ladder's
    // no-candidate branch with nothing to say about whether a human was owed.
    it('a row with a routing outcome but no requirement abstains on the requirement only', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'a', no_candidate: true });
      expect(await reviewRouting(db, team.id, 'a')).toEqual({
        routed: false,
        human_required: undefined,
        promised_ms: undefined,
      });
    });

    // ADR 217: the promised window rides the same read, under the same discipline. It is the input
    // the close edge grades `time_in_review_ms` against, so an absent or nonsense value has to abstain
    // — a zero-or-negative window would grade EVERY close as an honoured wait, silently converting the
    // impatience count this ADR exists to expose into a clean zero.
    it('reads a recorded promised window, and abstains on every shape that is not one', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, {
        lane: 'ok',
        reviewer: 'gee',
        human_required: false,
        ask_timeout_ms: 300_000,
      });
      await ready(db, team.id, { lane: 'legacy', reviewer: 'gee', human_required: false });
      await ready(db, team.id, {
        lane: 'zero',
        reviewer: 'gee',
        human_required: false,
        ask_timeout_ms: 0,
      });
      await ready(db, team.id, {
        lane: 'neg',
        reviewer: 'gee',
        human_required: false,
        ask_timeout_ms: -1,
      });
      await ready(db, team.id, {
        lane: 'str',
        reviewer: 'gee',
        human_required: false,
        ask_timeout_ms: '5m',
      });
      expect((await reviewRouting(db, team.id, 'ok')).promised_ms).toBe(300_000);
      expect((await reviewRouting(db, team.id, 'legacy')).promised_ms).toBeUndefined();
      expect((await reviewRouting(db, team.id, 'zero')).promised_ms).toBeUndefined();
      expect((await reviewRouting(db, team.id, 'neg')).promised_ms).toBeUndefined();
      expect((await reviewRouting(db, team.id, 'str')).promised_ms).toBeUndefined();
    });

    // A no-candidate ready row promised nobody anything. It must not carry a window — and if some
    // future writer puts one there, the close edge still never reaches the grading branch, because
    // `routed: false` lands on no_candidate/human_review_missed first.
    it('a no-candidate row carries no promised window', async () => {
      const { db, team } = await seed();
      await ready(db, team.id, { lane: 'nobody', no_candidate: true, human_required: false });
      expect((await reviewRouting(db, team.id, 'nobody')).promised_ms).toBeUndefined();
    });
  });

  /**
   * Lane 01M1QYHJFY. A hand re-route of a standing acceptance writes its own verb,
   * `lane.review_rerouted`, and BOTH reads of "who holds this acceptance" must take the newer of the
   * two rows — otherwise the close edge grades a re-routed lane against the seat whose ask was
   * closed, and a re-route of a no-candidate submit is recorded as a self-close.
   */
  describe('reviewRouting / standingAcceptance read the newest of submit and re-route', async () => {
    const seed = async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      return { db, team };
    };
    const row = async (
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      action: 'lane.ready_for_review' | 'lane.review_rerouted',
      detail: Record<string, unknown> & { lane: string },
    ) =>
      await appendAudit(db, teamId, {
        actor: 'ada',
        action,
        target: detail.lane,
        result: 'allow',
        detail,
      });

    // Both reads order by `ts DESC, id DESC`, and two rows appended inside one millisecond tie on
    // `ts` — in production the submit and the re-route are seconds apart. Advance the clock between
    // them so the test measures the read order, not the ulid tiebreak.
    const nextMs = () => {
      const t = Date.now();
      while (Date.now() === t) {
        /* spin — one millisecond at most */
      }
    };

    it('a re-route after a no-candidate submit reads as routed, with the new promise', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'a',
        no_candidate: true,
        human_required: false,
      });
      nextMs();
      await row(db, team.id, 'lane.review_rerouted', {
        lane: 'a',
        reviewer: 'hal',
        route: 'named',
        review_grade: 'cross_family',
        from_reviewer: null,
        superseded_ask: null,
        human_required: false,
        ask_tier: 'standard',
        ask_timeout_ms: 300_000,
      });
      expect(await reviewRouting(db, team.id, 'a')).toEqual({
        routed: true,
        human_required: false,
        promised_ms: 300_000,
      });
      expect(await standingAcceptance(db, team.id, 'a')).toEqual({
        reviewer: 'hal',
        route: 'named',
        grade: 'cross_family',
      });
    });

    it('a re-route names the new seat as standing, not the one the submit picked', async () => {
      const { db, team } = await seed();
      await row(db, team.id, 'lane.ready_for_review', {
        lane: 'b',
        reviewer: 'gee',
        route: 'cross_family',
        review_grade: 'cross_family',
        human_required: false,
      });
      nextMs();
      await row(db, team.id, 'lane.review_rerouted', {
        lane: 'b',
        reviewer: 'hal',
        route: 'named',
        review_grade: 'same_model',
        from_reviewer: 'gee',
        superseded_ask: '01ASK',
        human_required: false,
      });
      expect((await standingAcceptance(db, team.id, 'b'))?.reviewer).toBe('hal');
      // Mutation control: with the re-route verb dropped from either query, this reads `gee`.
    });
  });
});
