import { type Lane, leftoverSignal } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { followsUpNotice } from '../protocol/laneReroute.js';
import { decideFollowsUp } from '../sync/claim.js';
import { getLane, openLane, updateLane } from './lanes.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * ADR 487 §5.1 — closing a lane asks what is left, only when something points to leftover work.
 * The policy (`decideFollowsUp`) refuses; the store records the answer and attaches goalless
 * follow-ups to the closing lane's goal in the same write.
 */

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'bravo' });
  return { db, team };
}

const worker = { name: 'dolly', kind: 'agent' };
const acceptor = { name: 'sloane', kind: 'agent' };

async function refusal(fn: () => Promise<unknown>): Promise<MusterdError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MusterdError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('leftoverSignal — S2, a lane that declares itself one part of several', () => {
  it('finds N of M, N/M, increment N, phase N and an increment id', () => {
    for (const title of [
      'nothing-vanishes 3 of 5 — follows_up',
      'nothing-vanishes 3/5 — follows_up',
      'guidance-currency increment 2',
      'native harness phase 2',
      'Cloud 1C — tenancy',
    ])
      expect(leftoverSignal({ title, detail: null }), title).not.toBeNull();
  });

  it('reads the detail too', () => {
    expect(leftoverSignal({ title: 'gate', detail: 'Spec §7 increment 2.' })).toBe('increment 2');
  });

  it('stays quiet on one-shot work, dates and ADR numbers', () => {
    for (const title of [
      'fix the doorbell SSRF',
      'ADR 466 parked state',
      'landed 2026-09-30',
      'PR #1894 follow-up wording',
    ])
      expect(leftoverSignal({ title, detail: null }), title).toBeNull();
  });
});

withDrivers('follows_up', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function part(db: Driver, team: { id: string; slug: string }, extra = {}): Promise<Lane> {
    return openLane(db, team.id, team.slug, 'dolly', {
      title: 'nothing-vanishes 3/5',
      claim: true,
      ...extra,
    });
  }

  describe('decideFollowsUp — the refusal (ADR 487 §5.1)', () => {
    it('refuses a submit or a close of a signalled lane that says nothing, naming the field', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      for (const state of ['awaiting_acceptance', 'done'] as const) {
        const err = await refusal(() => decideFollowsUp(db, team.id, worker, l, { state }));
        expect(err.code).toBe('bad_request');
        expect(err.message).toContain('follows_up');
        expect(err.message).toContain('"3/5"');
      }
    });

    it('lets a one-shot lane close as today — absent reads as none', async () => {
      const { db, team } = await seed();
      const l = await openLane(db, team.id, team.slug, 'dolly', { title: 'fix it', claim: true });
      await expect(decideFollowsUp(db, team.id, worker, l, { state: 'done' })).resolves.toBe(
        undefined,
      );
    });

    it('accepts an explicit none', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      await expect(
        decideFollowsUp(db, team.id, worker, l, { state: 'done', follows_up: 'none' }),
      ).resolves.toBe(undefined);
    });

    it('asks only once: a lane answered at submit is not asked again at its close', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      const submitted = (await updateLane(db, team.id, l.id, team.slug, {
        state: 'awaiting_acceptance',
        follows_up: 'none',
      }))!;
      await expect(
        decideFollowsUp(db, team.id, worker, submitted, { state: 'done' }),
      ).resolves.toBe(undefined);
    });

    it("never asks an acceptor — their accept judges the outcome, not the worker's plan", async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      await expect(decideFollowsUp(db, team.id, acceptor, l, { state: 'done' })).resolves.toBe(
        undefined,
      );
    });

    it('refuses an unknown lane, the lane itself, and a silent drop', async () => {
      const { db, team } = await seed();
      const l = await part(db, team, { goal_id: 'g' });
      const dropped = await openLane(db, team.id, team.slug, 'dolly', { title: 'old' });
      await updateLane(db, team.id, dropped.id, team.slug, { state: 'abandoned' });
      for (const [ids, says] of [
        [['01NOPE'], 'no lane on this team'],
        [[l.id], 'itself'],
        [[dropped.id], 'abandoned with no reason'],
      ] as const) {
        const err = await refusal(() =>
          decideFollowsUp(db, team.id, worker, l, { state: 'done', follows_up: [...ids] }),
        );
        expect(err.message).toContain(says);
      }
    });

    it('accepts an abandoned follow-up that says why', async () => {
      const { db, team } = await seed();
      const l = await part(db, team, { goal_id: 'g' });
      const dropped = await openLane(db, team.id, team.slug, 'dolly', { title: 'old' });
      await updateLane(db, team.id, dropped.id, team.slug, {
        state: 'abandoned',
        abandon_reason: 'superseded by ADR 475',
      });
      await expect(
        decideFollowsUp(db, team.id, worker, l, { state: 'done', follows_up: [dropped.id] }),
      ).resolves.toBe(undefined);
    });

    it('refuses a goalless lane naming a goalless follow-up, with the repair', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      const next = await openLane(db, team.id, team.slug, 'dolly', { title: 'part 4' });
      const err = await refusal(() =>
        decideFollowsUp(db, team.id, worker, l, { state: 'done', follows_up: [next.id] }),
      );
      expect(err.message).toContain('team_goal_declare');
      expect(err.message).toContain('goal_id');
    });

    it('refuses abandon_reason off the move to abandoned', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      const err = await refusal(() =>
        decideFollowsUp(db, team.id, worker, l, { state: 'done', abandon_reason: 'x' }),
      );
      expect(err.message).toContain('abandoned');
    });
  });

  describe('the store — record the answer, attach the tail', () => {
    it('records the answer and attaches a goalless follow-up to the closing goal', async () => {
      const { db, team } = await seed();
      const l = await part(db, team, { goal_id: 'nothing-vanishes' });
      const next = await openLane(db, team.id, team.slug, 'dolly', { title: 'part 4' });
      const kept = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'elsewhere',
        goal_id: 'cloud',
      });
      const closed = (await updateLane(
        db,
        team.id,
        l.id,
        team.slug,
        { state: 'done', follows_up: [next.id, kept.id] },
        1,
        undefined,
        { actor: 'dolly' },
      ))!;
      expect(closed.follows_up).toEqual([next.id, kept.id]);
      expect((await getLane(db, team.id, next.id, team.slug))!.goal_id).toBe('nothing-vanishes');
      expect((await getLane(db, team.id, kept.id, team.slug))!.goal_id).toBe('cloud');
    });

    it('keeps the drop reason while abandoned and clears it if the lane is reopened', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      const dropped = (await updateLane(db, team.id, l.id, team.slug, {
        state: 'abandoned',
        abandon_reason: 'low value',
      }))!;
      expect(dropped.abandon_reason).toBe('low value');
      const later = (await updateLane(db, team.id, l.id, team.slug, { detail: 'note' }))!;
      expect(later.abandon_reason).toBe('low value');
      const reopened = (await updateLane(db, team.id, l.id, team.slug, { state: 'open' }))!;
      expect(reopened.abandon_reason).toBeUndefined();
    });
  });

  describe('followsUpNotice — what the acceptor sees', () => {
    it('lists each named lane with its state, and a drop with its reason', async () => {
      const { db, team } = await seed();
      const l = await part(db, team, { goal_id: 'g' });
      const next = await openLane(db, team.id, team.slug, 'dolly', { title: 'part 4' });
      const dropped = await openLane(db, team.id, team.slug, 'dolly', { title: 'old' });
      await updateLane(db, team.id, dropped.id, team.slug, {
        state: 'abandoned',
        abandon_reason: 'low value',
      });
      const closed = (await updateLane(db, team.id, l.id, team.slug, {
        state: 'awaiting_acceptance',
        follows_up: [next.id, dropped.id],
      }))!;
      const notice = await followsUpNotice(db, team.id, closed);
      expect(notice).toContain(`${next.id} [open] "part 4"`);
      expect(notice).toContain(`${dropped.id} dropped — low value`);
    });

    it('says an explicit none on a signalled lane, and nothing on a one-shot one', async () => {
      const { db, team } = await seed();
      const l = await part(db, team);
      const answered = (await updateLane(db, team.id, l.id, team.slug, { follows_up: 'none' }))!;
      expect(await followsUpNotice(db, team.id, answered)).toContain('Follows up: none');
      const one = await openLane(db, team.id, team.slug, 'dolly', { title: 'fix it' });
      expect(await followsUpNotice(db, team.id, one)).toBe('');
    });
  });
});
