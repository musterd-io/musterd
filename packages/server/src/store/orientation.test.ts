import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit } from './audit.js';
import { recordBlockedReport } from './incidents.js';
import { openLane, updateLane } from './lanes.js';
import { addMember, getMemberByName } from './members.js';
import { setCursor } from './cursors.js';
import { insertMessage } from './messages.js';
import {
  WHY_BARE_MAX_AGE_MS,
  deriveNext,
  deriveNextSummary,
  deriveTeamReviewPromises,
} from './orientation.js';
import { captureRepoSeed, createSeedFromRelay } from './seeds.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('orientation', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const stanley = (await addMember(db, team, { name: 'stanley', kind: 'agent' })).row;
    return { db, team, nick, stanley };
  }

  describe('deriveNext — the orientation brief (ADR 049/084)', async () => {
    it('sorts lanes into carrying / shipped / up_next from the daemon state alone', async () => {
      const { db, team } = await seed();
      // stanley is carrying one active lane...
      const active = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'spine',
        claim: true,
      });
      await updateLane(db, team.id, active.id, 'revive', { state: 'active' });
      // ...has shipped one...
      const shipped = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'migration',
        claim: true,
      });
      await updateLane(db, team.id, shipped.id, 'revive', { state: 'done' });
      // ...and there's an unowned lane anyone could pick up.
      const open = await openLane(db, team.id, 'revive', 'nick', { title: 'backlog item' });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.member).toBe('stanley');
      expect(brief.in_flight.map((l) => l.id)).toEqual([active.id]);
      expect(brief.shipped.map((l) => l.id)).toEqual([shipped.id]);
      expect(brief.up_next.map((l) => l.id)).toEqual([open.id]);
      expect(brief.why).toBeNull();
    });

    // Lane 01M2GTB0RA: the statusline and the per-turn orient nudge called /next — the whole brief,
    // 0.5 s on the live db and 1.8 s under load — nine sessions at a time, for three numbers. The
    // summary is those numbers from three bounded queries, and must agree with the brief.
    it('deriveNextSummary agrees with the brief on carrying, incidents and owed, from bounded queries', async () => {
      const { db, team } = await seed();
      const active = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'spine',
        claim: true,
      });
      await updateLane(db, team.id, active.id, 'revive', { state: 'active' });
      const shipped = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'done one',
        claim: true,
      });
      await updateLane(db, team.id, shipped.id, 'revive', { state: 'done' });
      const incident = await openLane(db, team.id, 'revive', 'nick', {
        title: 'incident: daemon_down',
        kind: 'incident',
      });
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      const summary = await deriveNextSummary(db, team.id, 'revive', 'stanley');
      expect(summary.carrying).toBe(brief.in_flight.length);
      expect(summary.carrying).toBe(1);
      expect(summary.incidents).toEqual(brief.incidents.map((i) => i.lane));
      expect(summary.incidents).toEqual([incident.id]);
      expect(summary.owed).toEqual(brief.owed_reviews.map((r) => ({ lane: r.lane.id, ts: r.ts })));
    });

    it('surfaces the latest handoff to me or @team as the why, with its goal_id', async () => {
      const { db, team, nick } = await seed();
      await insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: 'h1',
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body: 'pick up the orientation spine next',
          ts: 1_000,
          meta: { goal_id: 'orientation-spine' },
        }),
      );
      // Pinned to the handoff's own clock: this one names no lane, so it is subject to the
      // WHY_BARE_MAX_AGE_MS bound and would otherwise age out against a real `Date.now()`.
      const brief = await deriveNext(db, team.id, 'revive', 'stanley', 3, 5, { now: 1_000 });
      expect(brief.why).not.toBeNull();
      expect(brief.why!.from).toBe('nick');
      expect(brief.why!.body).toContain('orientation spine');
      expect(brief.why!.goal_id).toBe('orientation-spine');
    });

    // The lane that is done-but-not-closed is the one nobody sees: it is not `open`, so `up_next`
    // skips it, and before this it was not in LIVE either, so its own owner's brief said nothing about
    // it at all. Four of dolly's lanes sat that way for days (01KYN3CKJE, 01KYX7YGNK, 01KYX89VFB).
    // NextBriefSchema has always documented in_flight as carrying awaiting_acceptance; only the
    // implementation disagreed.
    it('carries a lane awaiting acceptance — the owner is still on the hook for it', async () => {
      const { db, team } = await seed();
      const submitted = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'merged days ago',
        claim: true,
      });
      await updateLane(db, team.id, submitted.id, 'revive', { state: 'awaiting_acceptance' });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.in_flight.map((l) => l.id)).toEqual([submitted.id]);
      // ...and it must NOT read as pickup-able work for anyone else.
      expect(brief.up_next).toHaveLength(0);
    });

    // The `why` is enrichment for what you are carrying. A handoff whose lane has since closed is
    // describing finished work, and reads as a live instruction: this brief told dolly that step 7 of
    // the MCP adoption was outstanding four days after the PR carrying step 7 had merged.
    it('skips a handoff whose lane has since resolved, and falls back to the newest live one', async () => {
      const { db, team, nick } = await seed();
      const stale = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'already merged',
        claim: true,
      });
      const live = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'still going',
        claim: true,
      });
      for (const [id, lane, ts, body] of [
        ['h-live', live.id, 1_000, 'this one is still real'],
        ['h-stale', stale.id, 2_000, 'finish step 7'],
      ] as const) {
        await insertMessage(
          db,
          team.id,
          nick.id,
          null,
          makeEnvelope({
            id,
            team: 'revive',
            from: 'nick',
            to: { kind: 'team' },
            act: 'handoff',
            body,
            ts,
            meta: { lane_handoff: { lane } },
          }),
        );
      }
      // The newest handoff is the stale one — without the join it wins on ts alone.
      await updateLane(db, team.id, stale.id, 'revive', { state: 'done' });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.why).not.toBeNull();
      expect(brief.why!.body).toBe('this one is still real');
    });

    // #745: a named lane that has been submitted is already off the recipient's plate. The why used
    // to skip only `done`/`abandoned`, so a handoff whose PR had merged but whose lane was still
    // awaiting_acceptance kept reading as a live instruction.
    it('skips a handoff whose lane is awaiting acceptance — same #745 out-of-play rule as wakes', async () => {
      const { db, team, nick } = await seed();
      const submitted = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'merged, waiting on accept',
        claim: true,
      });
      const live = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'still going',
        claim: true,
      });
      for (const [id, lane, ts, body] of [
        ['h-live', live.id, 1_000, 'this one is still real'],
        ['h-submitted', submitted.id, 2_000, 'finish the merged one'],
      ] as const) {
        await insertMessage(
          db,
          team.id,
          nick.id,
          null,
          makeEnvelope({
            id,
            team: 'revive',
            from: 'nick',
            to: { kind: 'team' },
            act: 'handoff',
            body,
            ts,
            meta: { lane_handoff: { lane } },
          }),
        );
      }
      await updateLane(db, team.id, submitted.id, 'revive', { state: 'awaiting_acceptance' });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.why!.body).toBe('this one is still real');
    });

    // The property that makes DERIVING this (rather than storing a flag) the right shape: a rejected
    // acceptance sends the lane back to active and the why becomes that handoff again.
    it('re-serves the why when acceptance sends the named lane back to active', async () => {
      const { db, team, nick } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'bounced',
        claim: true,
      });
      await insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: 'h-bounce',
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body: 'this came back',
          ts: 1_000,
          meta: { lane_handoff: { lane: lane.id } },
        }),
      );
      await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).why).toBeNull();

      await updateLane(db, team.id, lane.id, 'revive', { state: 'active' });
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).why!.body).toBe('this came back');
    });

    // A handoff that names no lane cannot be checked, so it must still be served: abstain by showing
    // it, never by hiding it (ADR 173 — an unknown is not a falsy). Bounded by age, not unbounded:
    // see the WHY_BARE_MAX_AGE_MS pair below.
    it('still serves a handoff that carries no lane reference', async () => {
      const { db, team, nick } = await seed();
      await insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: 'h-bare',
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body: 'no lane on this one',
          ts: 3_000,
          meta: {},
        }),
      );
      const brief = await deriveNext(db, team.id, 'revive', 'stanley', 3, 5, { now: 3_000 });
      expect(brief.why?.body).toBe('no lane on this one');
    });

    // A bare handoff can never be discharged by any event — no lane to check, and nothing reads its
    // prose. Left unbounded it holds the why slot PERMANENTLY. Measured 2026-08-13 across the real
    // ledger: 21 of 22 seats were pinned to a bare handoff, 19 of them to the same 38-day-old
    // completion notice. So age is the only recorded fact left that can retire one, and the bound is
    // set above the whole observed distribution of live handoffs (max 12.8d, p95 6.6d) — it retires
    // nothing that was ever live. Wakes are untouched: this is the why slot only, where showing a
    // dead instruction is not abstention but misdirection.
    it('stops serving a bare handoff once it is older than the age bound', async () => {
      const { db, team, nick } = await seed();
      await insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: 'h-bare-old',
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body: 'a premise that died two weeks ago',
          ts: 1_000,
          meta: {},
        }),
      );
      const fresh = await deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
        now: 1_000 + WHY_BARE_MAX_AGE_MS,
      });
      expect(fresh.why?.body).toBe('a premise that died two weeks ago');

      const stale = await deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
        now: 1_000 + WHY_BARE_MAX_AGE_MS + 1,
      });
      expect(stale.why).toBeNull();
    });

    // The bound is the fallback for the uncheckable case only. A handoff that names a live lane is a
    // recorded fact and outranks age — it keeps its slot however old it gets.
    it('does not age out a handoff whose named lane is still live', async () => {
      const { db, team, nick } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'still going',
        claim: true,
      });
      await insertMessage(
        db,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: 'h-named-old',
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'handoff',
          body: 'this one is still real',
          ts: 1_000,
          meta: { lane_handoff: { lane: lane.id } },
        }),
      );
      const brief = await deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
        now: 1_000 + WHY_BARE_MAX_AGE_MS * 10,
      });
      expect(brief.why?.body).toBe('this one is still real');
    });

    it('is the zero-compliance floor: empty when nothing is declared', async () => {
      const { db, team } = await seed();
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.in_flight).toHaveLength(0);
      expect(brief.shipped).toHaveLength(0);
      expect(brief.up_next).toHaveLength(0);
      expect(brief.why).toBeNull();
    });
  });

  // ADR 233. Measured: half the unverified self-closes had the named reviewer ONLINE for ~40 minutes
  // across an 18h window and still never answered — more awake time than the reviewers who did answer
  // (0.67h vs 0.22h). Having time was not the problem; being reminded was. The ask lands once in the
  // inbox and is never re-surfaced, and the brief a working seat actually reads had no field for it.
  describe('owed_reviews — the verdicts someone is waiting on from ME (ADR 233)', async () => {
    async function askReview(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      from: { id: string; name: string },
      toId: string,
      lane: string,
      id: string,
      ts = 1_000,
    ) {
      await insertMessage(
        db,
        teamId,
        from.id,
        toId,
        makeEnvelope({
          id,
          team: 'revive',
          from: from.name,
          to: { kind: 'member', name: 'stanley' },
          act: 'ask',
          body: `[lane] acceptance requested`,
          ts,
          meta: { lane_review: { lane }, species: 'approve', tier: 'standard' },
        }),
      );
    }

    it('names a lane whose review ask was routed to me, with who is waiting and since when', async () => {
      const { db, team, nick, stanley } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'nick', {
        title: 'nick built this',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, stanley.id, lane.id, 'ask-1', 5_000);

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.owed_reviews).toHaveLength(1);
      expect(brief.owed_reviews[0]!.lane.id).toBe(lane.id);
      expect(brief.owed_reviews[0]!.from).toBe('nick');
      expect(brief.owed_reviews[0]!.ask_id).toBe('ask-1');
      expect(brief.owed_reviews[0]!.ts).toBe(5_000);
    });

    // The whole point: this must survive the seat being heads-down. The inbox scrolls; the brief does
    // not. A seat carrying its own work still owes the verdict.
    it('shows the owed review even while I am carrying my own lanes', async () => {
      const { db, team, nick, stanley } = await seed();
      const mine = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'my work',
        claim: true,
      });
      await updateLane(db, team.id, mine.id, 'revive', { state: 'active' });
      const theirs = await openLane(db, team.id, 'revive', 'nick', {
        title: 'theirs',
        claim: true,
      });
      await updateLane(db, team.id, theirs.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, stanley.id, theirs.id, 'ask-2');

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.in_flight.map((l) => l.id)).toEqual([mine.id]);
      expect(brief.owed_reviews.map((r) => r.lane.id)).toEqual([theirs.id]);
    });

    // Answering IS closing the lane (ADR 192, as repaired) — so "still awaiting" is the whole
    // unanswered test. No accept-message bookkeeping to drift out of sync with the lane state.
    it('drops the review once the lane leaves awaiting_acceptance', async () => {
      const { db, team, nick, stanley } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'nick', {
        title: 'reviewed',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, stanley.id, lane.id, 'ask-3');
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).owed_reviews).toHaveLength(1);

      await updateLane(db, team.id, lane.id, 'revive', { state: 'done' });
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).owed_reviews).toEqual([]);
    });

    // Lane 01M2TNWK0K: after a re-route the relieved seat's brief still named the lane as owed.
    // The verdict edge and `openAcceptanceAsk` already exclude superseded asks; the brief did not,
    // so wanderer's `next` said "verdict owed" on #1541 and both wanderer and ryder judged it.
    it('drops the review once a re-route has superseded my ask — the new acceptor alone owes it', async () => {
      const { db, team, nick, stanley } = await seed();
      const miley = (await addMember(db, team, { name: 'miley', kind: 'agent' })).row;
      const lane = await openLane(db, team.id, 'revive', 'nick', {
        title: 'rerouted',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, stanley.id, lane.id, 'ask-old', 1_000);
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).owed_reviews).toHaveLength(1);

      // The re-route: audit row names the superseded ask, and a fresh ask goes to miley.
      await appendAudit(db, team.id, {
        actor: 'stanley',
        action: 'lane.review_rerouted',
        target: lane.id,
        result: 'allow',
        detail: {
          lane: lane.id,
          reviewer: 'miley',
          from_reviewer: 'stanley',
          superseded_ask: 'ask-old',
        },
      });
      await askReview(db, team.id, nick, miley.id, lane.id, 'ask-new', 2_000);

      expect((await deriveNext(db, team.id, 'revive', 'stanley')).owed_reviews).toEqual([]);
      expect(
        (await deriveNext(db, team.id, 'revive', 'miley')).owed_reviews.map((r) => r.ask_id),
      ).toEqual(['ask-new']);
      // The statusline / orient-nudge summary is a separate bounded query and must agree.
      expect((await deriveNextSummary(db, team.id, 'revive', 'stanley')).owed).toEqual([]);
      expect((await deriveNextSummary(db, team.id, 'revive', 'miley')).owed).toEqual([
        { lane: lane.id, ts: 2_000 },
      ]);
    });

    it('never asks me to review my own lane, even if an ask names me', async () => {
      const { db, team, nick, stanley } = await seed();
      const mine = await openLane(db, team.id, 'revive', 'stanley', { title: 'mine', claim: true });
      await updateLane(db, team.id, mine.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, stanley.id, mine.id, 'ask-4');

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.owed_reviews).toEqual([]);
      expect(brief.in_flight.map((l) => l.id)).toEqual([mine.id]); // still MY lane to carry
    });

    it('ignores a review routed to someone else', async () => {
      const { db, team, nick } = await seed();
      const other = (await addMember(db, team, { name: 'miley', kind: 'agent' })).row;
      const lane = await openLane(db, team.id, 'revive', 'nick', {
        title: 'not mine',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, other.id, lane.id, 'ask-5');

      expect((await deriveNext(db, team.id, 'revive', 'stanley')).owed_reviews).toEqual([]);
      expect((await deriveNext(db, team.id, 'revive', 'miley')).owed_reviews).toHaveLength(1);
    });

    it('is empty when nothing is owed — the common case stays quiet', async () => {
      const { db, team } = await seed();
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).owed_reviews).toEqual([]);
    });

    // Oldest first: the one that has been waiting longest is the one most likely to be swept
    // unverified, so it is the one to answer first.
    it('sorts oldest ask first', async () => {
      const { db, team, nick, stanley } = await seed();
      const a = await openLane(db, team.id, 'revive', 'nick', { title: 'a', claim: true });
      const b = await openLane(db, team.id, 'revive', 'nick', { title: 'b', claim: true });
      await updateLane(db, team.id, a.id, 'revive', { state: 'awaiting_acceptance' });
      await updateLane(db, team.id, b.id, 'revive', { state: 'awaiting_acceptance' });
      await askReview(db, team.id, nick, stanley.id, b.id, 'ask-new', 9_000);
      await askReview(db, team.id, nick, stanley.id, a.id, 'ask-old', 1_000);

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.owed_reviews.map((r) => r.ask_id)).toEqual(['ask-old', 'ask-new']);
    });
  });

  describe('brief leads with goals (goals-front-door design)', async () => {
    async function declareGoal(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      fromId: string,
      goal: { id: string; title: string; story?: string; wave?: number | 'later' },
      ts: number,
    ) {
      await insertMessage(
        db,
        teamId,
        fromId,
        null,
        makeEnvelope({
          id: `gd${ts}-${goal.id}`,
          team: 'revive',
          from: 'nick',
          to: { kind: 'team' },
          act: 'message',
          body: `[goal] ${goal.title}`,
          meta: { goal },
          ts,
        }),
      );
    }

    it('brief leads with unshipped goals, wave-ordered, and up_next puts goal-attached lanes first', async () => {
      const { db, team, nick } = await seed();
      await declareGoal(db, team.id, nick.id, { id: 'g2', title: 'Second', wave: 2 }, 10);
      await declareGoal(db, team.id, nick.id, { id: 'g1', title: 'First', wave: 1 }, 20);
      // Two open lanes, the ungrouped one created first — attachment must still win the sort.
      await openLane(db, team.id, 'revive', 'nick', { title: 'ungrouped' });
      await openLane(db, team.id, 'revive', 'nick', { title: 'on g1', goal_id: 'g1' });
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.goals.map((g) => g.id)).toEqual(['g1', 'g2']);
      expect(brief.up_next[0]!.goal_id).toBe('g1');
    });

    it('shipped goals are excluded and in-flight sorts before planned at equal wave', async () => {
      const { db, team, nick } = await seed();
      await declareGoal(db, team.id, nick.id, { id: 'ga', title: 'A planned', wave: 1 }, 10);
      await declareGoal(db, team.id, nick.id, { id: 'gb', title: 'B in flight', wave: 1 }, 20);
      await declareGoal(db, team.id, nick.id, { id: 'gc', title: 'C shipped', wave: 1 }, 30);
      const flight = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'w',
        goal_id: 'gb',
        claim: true,
      });
      await updateLane(db, team.id, flight.id, 'revive', { state: 'active' });
      const done = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'd',
        goal_id: 'gc',
        claim: true,
      });
      await updateLane(db, team.id, done.id, 'revive', { state: 'done' });
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.goals.map((g) => g.id)).toEqual(['gb', 'ga']);
    });
  });

  /**
   * "recently shipped" must not call an unconfirmed close a confirmed one (lane 01M06PR40).
   *
   * ADR 169 derives `verified` on every close and the `/lanes` endpoint has annotated done lanes with
   * it since — which is why the web board has rendered accepted/unconfirmed chips all along
   * (Board.tsx:409-416). `deriveNext` never applied the same annotation, so the ONE place a seat reads
   * what just landed showed a swept, unreviewed lane exactly like a peer-accepted one.
   *
   * Measured 2026-08-15: lane 01M016D5GA — 44 files joining typecheck, every CI-deciding gate among
   * them — was swept at 24h with `verified: false` and listed under "recently shipped" unmarked.
   */
  describe('shipped carries the verified-ness of its close', async () => {
    async function closedRow(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      laneId: string,
      verified: boolean,
    ) {
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, ?, 'lane.closed', ?, 'allow', ?, ?)`,
        [
          `closed-${laneId}`,
          teamId,
          Date.now(),
          'musterd',
          laneId,
          JSON.stringify({ lane: laneId, state: 'done', verified }),
          Date.now(),
        ],
      );
    }
    async function shippedLane(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      title: string,
      verified: boolean,
    ) {
      const lane = await openLane(db, teamId, 'revive', 'stanley', { title, claim: true });
      await updateLane(db, teamId, lane.id, 'revive', { state: 'done' });
      await closedRow(db, teamId, lane.id, verified);
      return lane;
    }

    it('marks a close nobody confirmed, so the brief stops calling it shipped-and-fine', async () => {
      const { db, team } = await seed();
      await shippedLane(db, team.id, 'swept', false);
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.shipped.find((l) => l.title === 'swept')?.verified).toBe(false);
    });

    it('marks a counterpart-accepted close as verified', async () => {
      const { db, team } = await seed();
      await shippedLane(db, team.id, 'accepted', true);
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.shipped.find((l) => l.title === 'accepted')?.verified).toBe(true);
    });

    it('ABSTAINS on a close that recorded no verdict — pre-ADR-169 lanes invent nothing', async () => {
      const { db, team } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'stanley', {
        title: 'ancient',
        claim: true,
      });
      await updateLane(db, team.id, lane.id, 'revive', { state: 'done' });
      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      // Absent, never defaulted to false: "we do not know" and "nobody confirmed it" are different
      // claims, and only one of them is true here.
      expect(brief.shipped.find((l) => l.title === 'ancient')).not.toHaveProperty('verified');
    });
  });

  describe('review_debt (value-layer design)', async () => {
    async function insertReadyAudit(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      target: string,
      ts: number,
      detail: string | null = null,
    ) {
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `rd${ts}-${target}`,
          teamId,
          ts,
          'stanley',
          'lane.ready_for_review',
          target,
          'allow',
          detail,
          ts,
        ],
      );
    }
    async function awaiting(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      title: string,
      agoMs: number,
      owner = 'stanley',
      detail: Record<string, unknown> | null = null,
    ) {
      const lane = await openLane(db, teamId, 'revive', owner, { title, claim: true });
      const moved = (await updateLane(db, teamId, lane.id, 'revive', {
        state: 'awaiting_acceptance',
      }))!;
      await insertReadyAudit(
        db,
        teamId,
        moved.id,
        Date.now() - agoMs,
        detail ? JSON.stringify(detail) : null,
      );
      return moved;
    }

    // C — the cap lied by omission. Three rows and no total is indistinguishable from three rows and
    // nothing else, so a seat clears the queue, looks again, and finds more. Measured 2026-08-15:
    // cleared 3, two more appeared, and only then was the depth knowable.
    it('reports the TOTAL waiting, not just the three it shows', async () => {
      const { db, team } = await seed();
      for (let i = 0; i < 5; i++) await awaiting(db, team.id, `l${i}`, (30 - i) * 3_600_000);
      const brief = await deriveNext(db, team.id, 'revive', 'nick');
      expect(brief.review_debt).toHaveLength(3);
      expect(brief.review_debt_total).toBe(5);
    });

    it('total equals the shown count when the queue is shallow — no phantom depth', async () => {
      const { db, team } = await seed();
      await awaiting(db, team.id, 'only', 5 * 3_600_000);
      const brief = await deriveNext(db, team.id, 'revive', 'nick');
      expect(brief.review_debt_total).toBe(1);
    });

    // B — a lane nobody was ever asked to review. pickReviewCounterpart returns null on a
    // same-model monoculture (ADR 188/253 refuse same_model), the submit records
    // `no_candidate: true`, and then nothing says so: the lane simply waits, looking identical to
    // one with a named reviewer who is merely slow. Three of five lanes on 2026-08-15.
    it('marks a lane that no reviewer was ever asked to review', async () => {
      const { db, team } = await seed();
      await awaiting(db, team.id, 'nobody-asked', 20 * 3_600_000, 'stanley', {
        no_candidate: true,
        review_selection: {
          selected: null,
          candidates: [
            { member: 'stanley', exclusion: 'self' },
            { member: 'miley', exclusion: 'same_model' },
          ],
        },
      });
      await awaiting(db, team.id, 'routed', 10 * 3_600_000, 'stanley', { reviewer: 'miley' });
      const brief = await deriveNext(db, team.id, 'revive', 'nick');
      const byTitle = new Map(brief.review_debt!.map((r) => [r.title, r]));
      expect(byTitle.get('nobody-asked')!.no_candidate).toBe(true);
      expect(byTitle.get('nobody-asked')!.empty_pool).toEqual({
        kind: 'live_ineligible',
        live: [{ member: 'miley', exclusion: 'same_model' }],
      });
      expect(byTitle.get('routed')!.no_candidate).toBe(false);
      expect(byTitle.get('routed')!.empty_pool).toBeUndefined();
    });

    it('lists the 3 oldest awaiting-acceptance lanes, oldest first', async () => {
      const { db, team } = await seed();
      const old1 = await awaiting(db, team.id, 'a', 30 * 3_600_000);
      const old2 = await awaiting(db, team.id, 'b', 20 * 3_600_000);
      const old3 = await awaiting(db, team.id, 'c', 10 * 3_600_000);
      await awaiting(db, team.id, 'd', 1_000); // freshest — capped out
      const brief = await deriveNext(db, team.id, 'revive', 'nick');
      expect(brief.review_debt!.map((r) => r.id)).toEqual([old1.id, old2.id, old3.id]);
      expect(brief.review_debt![0]!.owner).toBe('stanley');
      expect(brief.review_debt![0]!.waited_ms).toBeGreaterThan(29 * 3_600_000);
    });

    it("excludes the requesting seat's own lanes — self-acceptance is never invited", async () => {
      const { db, team } = await seed();
      await awaiting(db, team.id, 'mine-a', 30 * 3_600_000);
      await awaiting(db, team.id, 'mine-b', 20 * 3_600_000);
      // ADR 192: `verified` requires closer ≠ owner, so a seat's own lane is never its
      // candidate review work — the whole field disappears when nothing else waits.
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_debt).toBeUndefined();
      expect((await deriveNext(db, team.id, 'revive', 'nick')).review_debt).toHaveLength(2);
    });

    it("an excluded own lane frees its cap slot for the next-oldest teammate's lane", async () => {
      const { db, team } = await seed();
      await awaiting(db, team.id, 'mine', 40 * 3_600_000); // oldest, but requester-owned
      const o1 = await awaiting(db, team.id, 'a', 30 * 3_600_000, 'nick');
      const o2 = await awaiting(db, team.id, 'b', 20 * 3_600_000, 'nick');
      const o3 = await awaiting(db, team.id, 'c', 10 * 3_600_000, 'nick');
      await awaiting(db, team.id, 'd', 1_000, 'nick'); // freshest — capped out
      const debt = (await deriveNext(db, team.id, 'revive', 'stanley')).review_debt!;
      expect(debt.map((r) => r.id)).toEqual([o1.id, o2.id, o3.id]);
    });

    it('is absent when nothing waits', async () => {
      const { db, team } = await seed();
      await openLane(db, team.id, 'revive', 'stanley', { title: 'live', claim: true });
      expect((await deriveNext(db, team.id, 'revive', 'nick')).review_debt).toBeUndefined();
    });
  });

  describe('incidents lead the brief (spec 2026-08-14 inc 1)', async () => {
    it('an open incident appears for every member; a terminal one does not', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      await addMember(db, team, { name: 'miley', kind: 'agent' });
      await recordBlockedReport(
        db,
        team.id,
        'revive',
        'izzo',
        { gate: 'ci:gates/A11y contrast' },
        'm1',
      );
      await recordBlockedReport(
        db,
        team.id,
        'revive',
        'dolly',
        { gate: 'ci:gates/A11y contrast' },
        'm2',
      );
      const brief = await deriveNext(db, team.id, 'revive', 'miley');
      expect(brief.incidents).toHaveLength(1);
      expect(brief.incidents[0]).toMatchObject({
        gate: 'ci:gates/A11y contrast',
        owner_seat: null,
      });
      await updateLane(db, team.id, brief.incidents[0]!.lane, 'revive', { state: 'abandoned' });
      expect((await deriveNext(db, team.id, 'revive', 'miley')).incidents).toHaveLength(0);
    });
  });

  describe('review_debt unlanded badge (merge-verified submit)', async () => {
    it('marks a lane whose attestation has no SHA as unlanded, and an attested one as not', async () => {
      const { db, team } = await seed();
      const bare = await openLane(db, team.id, 'revive', 'nick', {
        title: 'no attestation',
        claim: true,
      });
      await updateLane(db, team.id, bare.id, 'revive', { state: 'awaiting_acceptance' });
      const attested = await openLane(db, team.id, 'revive', 'nick', {
        title: 'landed',
        claim: true,
      });
      await updateLane(db, team.id, attested.id, 'revive', {
        state: 'awaiting_acceptance',
        merged: { sha: 'abc123f', verification: 'ancestor' },
      });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      const byId = new Map((brief.review_debt ?? []).map((r) => [r.id, r]));
      expect(byId.get(bare.id)?.unlanded).toBe(true);
      expect(byId.get(attested.id)?.unlanded).toBe(false);
    });
  });

  describe('deriveNext — recorded intentions above the open lanes (ADR 373 increment 4)', async () => {
    async function capture(
      db: ReturnType<typeof seed>['db'],
      teamId: string,
      ref: string,
      body: string,
      at: number,
    ) {
      return await captureRepoSeed(
        db,
        teamId,
        await (await getMemberByName(db, teamId, 'nick'))!,
        { ref, body, captured_at: at },
        at,
      );
    }

    it('lists open Seeds oldest first, source-tagged, with the total behind the window', async () => {
      const { db, team } = await seed();
      const first = await capture(
        db,
        team.id,
        'docs/decisions/354-x.md#left-for-a-sibling-lane',
        'Left for a sibling lane; this ADR fixes the attestation.\n— docs/decisions/354-x.md:12',
        100,
      );
      const second = await capture(
        db,
        team.id,
        'docs/wiki/wake-leases.md#still-true',
        'still true, and not fixed here\n— docs/wiki/wake-leases.md:40',
        200,
      );
      await capture(
        db,
        team.id,
        'content/roadmap.data.ts#building-a',
        "building: 'increments 3–5'",
        300,
      );
      await capture(db, team.id, 'content/roadmap.data.ts#building-b', "building: 'M4–M5'", 400);

      const brief = await deriveNext(db, team.id, 'revive', 'stanley', 3, 5, {
        upNextSeedLimit: 2,
      });
      expect(brief.up_next_seeds.map((s) => s.id)).toEqual([first.id, second.id]);
      expect(brief.up_next_seeds_total).toBe(4);
      expect(brief.up_next_seeds[0]).toMatchObject({
        source: 'repo',
        ref: 'docs/decisions/354-x.md#left-for-a-sibling-lane',
        summary: 'Left for a sibling lane; this ADR fixes the attestation.',
        submitted_by: 'nick',
        captured_at: 100,
      });
    });

    it('drops a Seed once it is promoted — a started intention is a lane, not an intention', async () => {
      const { db, team } = await seed();
      const lane = await openLane(db, team.id, 'revive', 'nick', { title: 'the sibling lane' });
      await capture(db, team.id, 'docs/wiki/a.md#b', 'not yet built', 100);
      await captureRepoSeed(db, team.id, await (await getMemberByName(db, team.id, 'nick'))!, {
        ref: 'docs/decisions/354-x.md#c',
        body: 'Left for a sibling lane',
        lane_id: lane.id,
      });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.up_next_seeds.map((s) => s.ref)).toEqual(['docs/wiki/a.md#b']);
      expect(brief.up_next_seeds_total).toBe(1);
    });

    it('carries a relay Seed with a null ref — its source is a person, not a document', async () => {
      const { db, team } = await seed();
      await db.run("UPDATE members SET slack_user_id = 'U1' WHERE team_id = ? AND name = 'nick'", [
        team.id,
      ]);
      await createSeedFromRelay(db, team.id, {
        id: 'relay-1',
        source: 'slack',
        body: 'Which Surface should own this?',
        ts: 50,
        meta: { user: 'U1' },
      });

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.up_next_seeds).toMatchObject([
        { source: 'slack', ref: null, summary: 'Which Surface should own this?' },
      ]);
    });
  });

  // ADR 490: review promises are a projection of request, accept and resolve Acts — no table.
  describe('review promises (ADR 490)', () => {
    const PR = { kind: 'pr', repo: 'org/repo', number: 42 } as const;

    async function reviewSeed() {
      const base = await seed();
      const lin = (await addMember(base.db, base.team, { name: 'lin', kind: 'agent' })).row;
      const ids: Record<string, string> = {
        nick: base.nick.id,
        stanley: base.stanley.id,
        lin: lin.id,
      };
      /** One Act; `at` is its receipt clock (`created_at`), `ts` the sender's clock. */
      const send = async (
        from: string,
        to: string | null,
        input: {
          id: string;
          act: 'request_help' | 'accept' | 'decline' | 'resolve';
          ts: number;
          body?: string;
          thread?: string;
          meta?: Record<string, unknown>;
        },
        at = input.ts,
      ) =>
        insertMessage(
          base.db,
          base.team.id,
          ids[from]!,
          to === null ? null : ids[to]!,
          makeEnvelope({
            team: 'revive',
            from,
            to: to === null ? { kind: 'team' } : { kind: 'member', name: to },
            body: input.body ?? '',
            ...input,
          }),
          { now: at },
        );
      /** nick asks stanley to review PR 42 and stanley accepts. */
      const accepted = async (id: string, ts: number, owner = 'stanley') => {
        await send('nick', owner, {
          id,
          act: 'request_help',
          ts,
          body: `review ${id}`,
          meta: { review: PR },
        });
        await send(owner, 'nick', {
          id: `${id}-ok`,
          act: 'accept',
          ts: ts + 10,
          thread: id,
          meta: { in_reply_to: id },
        });
      };
      return { ...base, send, accepted };
    }

    it('shows an accepted, unresolved typed request to its owner and its requester', async () => {
      const { db, team, accepted } = await reviewSeed();
      await accepted('r1', 1_000);

      const row = {
        request_id: 'r1',
        requester: 'nick',
        owner: 'stanley',
        context: 'review r1',
        review: PR,
        accepted_at: 1_010,
      };
      const owner = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(owner.request_reviews).toEqual([row]);
      expect(owner.requested_reviews).toEqual([]);
      expect(owner.review_closures).toEqual([]);
      const requester = await deriveNext(db, team.id, 'revive', 'nick');
      expect(requester.request_reviews).toEqual([]);
      expect(requester.requested_reviews).toEqual([row]);
      // Lane acceptance keeps its own fields: a review promise is neither.
      expect(owner.owed_reviews).toEqual([]);
      expect(owner.review_debt).toBeUndefined();
      // A bystander gets supported-empty arrays, never absence.
      const lin = await deriveNext(db, team.id, 'revive', 'lin');
      expect([lin.request_reviews, lin.requested_reviews, lin.review_closures]).toEqual([[], [], []]);
    });

    it('derives nothing from untyped, unaccepted, declined or wrong-sender requests', async () => {
      const { db, team, send } = await reviewSeed();
      // Untyped request, accepted.
      await send('nick', 'stanley', { id: 'u1', act: 'request_help', ts: 1 });
      await send('stanley', 'nick', { id: 'u1-ok', act: 'accept', ts: 2, meta: { in_reply_to: 'u1' } });
      // Typed, never answered.
      await send('nick', 'stanley', { id: 't1', act: 'request_help', ts: 3, meta: { review: PR } });
      // Typed, declined.
      await send('nick', 'stanley', { id: 't2', act: 'request_help', ts: 4, meta: { review: PR } });
      await send('stanley', 'nick', { id: 't2-no', act: 'decline', ts: 5, meta: { in_reply_to: 't2' } });
      // Typed, accepted by someone who was not asked.
      await send('nick', 'stanley', { id: 't3', act: 'request_help', ts: 6, meta: { review: PR } });
      await send('lin', 'nick', { id: 't3-ok', act: 'accept', ts: 7, meta: { in_reply_to: 't3' } });

      for (const who of ['nick', 'stanley', 'lin']) {
        const brief = await deriveNext(db, team.id, 'revive', who);
        expect(brief.request_reviews).toEqual([]);
        expect(brief.requested_reviews).toEqual([]);
      }
      expect(await deriveTeamReviewPromises(db, team.id)).toEqual([]);
    });

    it('collapses duplicate accepts to the minimum (ts, id), whatever order they arrived in', async () => {
      const { db, team, send } = await reviewSeed();
      await send('nick', 'stanley', { id: 'r1', act: 'request_help', ts: 100, meta: { review: PR } });
      const ok = (id: string, ts: number, at: number) =>
        send('stanley', 'nick', { id, act: 'accept', ts, meta: { in_reply_to: 'r1' } }, at);
      await ok('b-late', 300, 301);
      await ok('b-tie', 200, 302);
      await ok('a-tie', 200, 303);

      const brief = await deriveNext(db, team.id, 'revive', 'stanley');
      expect(brief.request_reviews).toHaveLength(1);
      expect(brief.request_reviews![0]!.accepted_at).toBe(200);
    });

    it('orders open promises oldest acceptance first, request id breaking ties', async () => {
      const { db, team, accepted } = await reviewSeed();
      await accepted('r3', 500);
      await accepted('r2', 100);
      await accepted('r1', 100);

      const brief = await deriveNext(db, team.id, 'revive', 'nick');
      expect(brief.requested_reviews!.map((r) => r.request_id)).toEqual(['r1', 'r2', 'r3']);
      expect(await deriveTeamReviewPromises(db, team.id)).toEqual([
        { request_id: 'r1', requester: 'nick', owner: 'stanley', accepted_at: 110 },
        { request_id: 'r2', requester: 'nick', owner: 'stanley', accepted_at: 110 },
        { request_id: 'r3', requester: 'nick', owner: 'stanley', accepted_at: 510 },
      ]);
    });

    it('closes both rows on a Team resolve, with no notice when the owner closed it', async () => {
      const { db, team, send, accepted } = await reviewSeed();
      await accepted('r1', 1_000);
      await send('stanley', null, { id: 'r1-done', act: 'resolve', ts: 2_000, thread: 'r1' });

      for (const who of ['nick', 'stanley']) {
        const brief = await deriveNext(db, team.id, 'revive', who);
        expect(brief.request_reviews).toEqual([]);
        expect(brief.requested_reviews).toEqual([]);
        expect(brief.review_closures).toEqual([]);
      }
    });

    it("keeps one owner notice after a non-owner close until the owner's cursor crosses it", async () => {
      const { db, team, stanley, send, accepted } = await reviewSeed();
      await accepted('r1', 1_000);
      // The requester withdraws. Its sender clock runs far behind receipt: the cursor comparison
      // must use the receipt position, or this notice would read as already seen.
      await send('nick', null, { id: 'r1-withdrawn', act: 'resolve', ts: 5, thread: 'r1' }, 3_000);
      await send('lin', 'stanley', { id: 'later', act: 'request_help', ts: 1 }, 4_000);

      const notice = { request_id: 'r1', resolve_id: 'r1-withdrawn', closer: 'nick', resolved_at: 5 };
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_closures).toEqual([notice]);
      expect((await deriveNext(db, team.id, 'revive', 'nick')).review_closures).toEqual([]);

      // A cursor resting before the resolve (on the accept) keeps it.
      await setCursor(db, stanley.id, 'r1-ok');
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_closures).toEqual([notice]);
      // On the resolve itself, it is read.
      await setCursor(db, stanley.id, 'r1-withdrawn');
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_closures).toEqual([]);
      // Past it, still read.
      await setCursor(db, stanley.id, 'later');
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_closures).toEqual([]);
    });

    it('breaks a same-millisecond receipt tie on the resolve id, as the inbox cursor does', async () => {
      const { db, team, stanley, send, accepted } = await reviewSeed();
      await accepted('r1', 1_000);
      await send('nick', null, { id: 'm-resolve', act: 'resolve', ts: 9, thread: 'r1' }, 3_000);
      await send('lin', 'stanley', { id: 'a-before', act: 'request_help', ts: 1 }, 3_000);
      await send('lin', 'stanley', { id: 'z-after', act: 'request_help', ts: 1 }, 3_000);

      await setCursor(db, stanley.id, 'a-before');
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_closures).toHaveLength(1);
      await setCursor(db, stanley.id, 'z-after');
      expect((await deriveNext(db, team.id, 'revive', 'stanley')).review_closures).toEqual([]);
    });
  });
});
