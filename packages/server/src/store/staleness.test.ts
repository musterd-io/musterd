import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { staleLaneWarnings } from './staleness.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  return { db, team, nick };
}

/** Emit a `defer`/`steer` naming a Goal at a controlled ts (a plan-epoch bump). */
let mid = 0;
async function bump(
  db: ReturnType<typeof seed>['db'],
  teamId: string,
  fromId: string,
  goalId: string,
  ts: number,
  act: 'defer' | 'steer' = 'defer',
) {
  await insertMessage(
    db,
    teamId,
    fromId,
    null,
    makeEnvelope({
      id: `b${++mid}`,
      team: 'revive',
      from: 'nick',
      to: { kind: 'team' },
      act,
      body: `[${act}]`,
      meta: { goal_id: goalId, ...(act === 'defer' ? { wave: 'later' } : {}) },
      ts,
    }),
  );
}

withDrivers('staleness', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('staleLaneWarnings (ADR 111 — stale-plan detection, ADR 088 §5)', async () => {
    it('no warning when a lane was claimed at the Goal’s current epoch', async () => {
      const { db, team, nick } = await seed();
      // lane claimed at ts 100; a defer at ts 50 (BEFORE the claim) — the owner already had it.
      await bump(db, team.id, nick.id, 'spine', 50);
      await openLane(
        db,
        team.id,
        'revive',
        'stanley',
        { title: 'a', goal_id: 'spine', claim: true },
        100,
      );
      expect(await staleLaneWarnings(db, team.id, 'revive')).toEqual([]);
    });

    it('stale_plan fires when the lane’s own Goal advances an epoch after it was claimed', async () => {
      const { db, team, nick } = await seed();
      const lane = await openLane(
        db,
        team.id,
        'revive',
        'stanley',
        { title: 'a', goal_id: 'spine', claim: true },
        100,
      );
      await bump(db, team.id, nick.id, 'spine', 200); // plan moved AFTER the claim
      const warnings = await staleLaneWarnings(db, team.id, 'revive');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        kind: 'stale_plan',
        subject: lane.id,
        with: 'spine',
        owner: 'stanley',
      });
    });

    it('only warns live owned lanes — a done or unowned lane is never stale', async () => {
      const { db, team, nick } = await seed();
      const done = await openLane(
        db,
        team.id,
        'revive',
        'stanley',
        { title: 'done', goal_id: 'spine', claim: true },
        100,
      );
      await updateLane(db, team.id, done.id, 'revive', { state: 'done' });
      await openLane(db, team.id, 'revive', 'stanley', { title: 'open', goal_id: 'spine' }, 100); // unowned
      await bump(db, team.id, nick.id, 'spine', 200);
      expect(await staleLaneWarnings(db, team.id, 'revive')).toEqual([]);
    });

    it('stale_dependency: a lane building on a lane whose Goal moved is flagged specifically', async () => {
      const { db, team, nick } = await seed();
      // A on goal spine (claimed early), B depends on A (claimed early on a different goal).
      const a = await openLane(
        db,
        team.id,
        'revive',
        'june',
        { title: 'schema', goal_id: 'spine', claim: true },
        100,
      );
      const b = await openLane(
        db,
        team.id,
        'revive',
        'stanley',
        { title: 'client', goal_id: 'client', depends_on: [a.id], claim: true },
        100,
      );
      await bump(db, team.id, nick.id, 'spine', 200); // A's goal moved after B claimed
      const warnings = await staleLaneWarnings(db, team.id, 'revive');
      const dep = warnings.find((w) => w.kind === 'stale_dependency');
      expect(dep).toMatchObject({
        kind: 'stale_dependency',
        subject: b.id,
        with: a.id,
        owner: 'stanley',
      });
    });

    it('onlyGoal scopes the scan to the just-deferred Goal (the directed push)', async () => {
      const { db, team, nick } = await seed();
      await openLane(
        db,
        team.id,
        'revive',
        'stanley',
        { title: 'a', goal_id: 'spine', claim: true },
        100,
      );
      await openLane(
        db,
        team.id,
        'revive',
        'miley',
        { title: 'b', goal_id: 'other', claim: true },
        100,
      );
      await bump(db, team.id, nick.id, 'spine', 200);
      await bump(db, team.id, nick.id, 'other', 200);
      // Scoped to `spine` → only stanley's lane, not miley's `other` lane.
      const scoped = await staleLaneWarnings(db, team.id, 'revive', 'spine');
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.owner).toBe('stanley');
    });

    it('nothing is stale before any direction has changed', async () => {
      const { db, team } = await seed();
      await openLane(
        db,
        team.id,
        'revive',
        'stanley',
        { title: 'a', goal_id: 'spine', claim: true },
        100,
      );
      // no bumps at all — fast path returns []
      expect(await staleLaneWarnings(db, team.id, 'revive')).toEqual([]);
    });
  });
});
