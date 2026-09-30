import type { Lane, UpdateLane } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { decideParkPatch } from '../sync/claim.js';
import { getLane, openLane, updateLane } from './lanes.js';
import { deriveNext } from './orientation.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * ADR 466 — `parked`: kept, deliberately not now. Only a human parks or unparks; a parked lane is
 * unowned, refuses a claim, and is counted — never offered — in the brief.
 */

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'bravo' });
  return { db, team };
}

const human = { name: 'nick', kind: 'human' };
const agent = { name: 'fifty', kind: 'agent' };

function lane(state: Lane['state'], extra: Partial<Lane> = {}): Lane {
  return {
    id: 'L1',
    team: 'bravo',
    project: 'agents',
    title: 't',
    detail: null,
    owner_seat: state === 'open' || state === 'parked' ? null : 'fifty',
    role: null,
    scope: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal',
    stakes_provenance: 'declared',
    merged: null,
    state,
    created_by: 'nick',
    created_at: 0,
    claimed_at: null,
    resolved_at: null,
    updated_at: 0,
    ...extra,
  };
}

function refusal(fn: () => void): MusterdError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MusterdError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

const park: UpdateLane = { state: 'parked', park_reason: 'after launch' };
const parkedLane = lane('parked', { parked: { by: 'nick', at: 1, reason: 'after launch' } });

withDrivers('parked', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('decideParkPatch — who may park, unpark, and claim (ADR 466)', () => {
    it('lets a human park an open, claimed, active or blocked lane', () => {
      for (const s of ['open', 'claimed', 'active', 'blocked'] as const)
        expect(() => decideParkPatch(human, lane(s), park)).not.toThrow();
    });

    it('refuses an agent that tries to park, and points it at `blocked`', () => {
      const err = refusal(() => decideParkPatch(agent, lane('active'), park));
      expect(err.code).toBe('forbidden');
      expect(err.message).toMatch(/blocked/);
    });

    it('refuses a park with no reason', () => {
      const err = refusal(() => decideParkPatch(human, lane('open'), { state: 'parked' }));
      expect(err.code).toBe('bad_request');
      expect(err.message).toMatch(/reason/);
    });

    it('refuses parking a lane already submitted or closed', () => {
      for (const s of ['awaiting_acceptance', 'done', 'abandoned'] as const)
        expect(refusal(() => decideParkPatch(human, lane(s), park)).code).toBe('bad_request');
    });

    it('lets a human unpark to open or abandoned, and nothing else', () => {
      expect(() => decideParkPatch(human, parkedLane, { state: 'open' })).not.toThrow();
      expect(() => decideParkPatch(human, parkedLane, { state: 'abandoned' })).not.toThrow();
      expect(refusal(() => decideParkPatch(human, parkedLane, { state: 'active' })).code).toBe(
        'bad_request',
      );
    });

    it('refuses an agent that tries to unpark', () => {
      const err = refusal(() => decideParkPatch(agent, parkedLane, { state: 'open' }));
      expect(err.code).toBe('forbidden');
      expect(err.message).toMatch(/after launch/);
    });

    it('refuses a claim or handoff of a parked lane, naming who parked it and why', () => {
      const err = refusal(() => decideParkPatch(agent, parkedLane, { owner_seat: 'fifty' }));
      expect(err.code).toBe('conflict');
      expect(err.message).toMatch(/parked by nick/);
      expect(err.message).toMatch(/after launch/);
      expect(refusal(() => decideParkPatch(human, parkedLane, { owner_seat: 'ghost' })).code).toBe(
        'conflict',
      );
    });

    it('leaves ordinary patches and `blocked` untouched', () => {
      expect(() => decideParkPatch(agent, lane('active'), { state: 'blocked' })).not.toThrow();
      expect(() => decideParkPatch(agent, parkedLane, { detail: 'note' })).not.toThrow();
    });
  });

  describe('the store — a parked lane is unowned and carries its reason (ADR 466)', async () => {
    it('parking a claimed lane releases the owner and records by/at/reason/until', async () => {
      const { db, team } = await seed();
      const l = await openLane(db, team.id, team.slug, 'fifty', { title: 'later', claim: true });
      const parked = (await updateLane(
        db,
        team.id,
        l.id,
        team.slug,
        { state: 'parked', park_reason: 'after launch', park_until: 1_800_000_000_000 },
        42,
        undefined,
        { actor: 'nick' },
      ))!;
      expect(parked.state).toBe('parked');
      expect(parked.owner_seat).toBeNull();
      expect(parked.claimed_at).toBeNull();
      expect(parked.parked).toEqual({
        by: 'nick',
        at: 42,
        reason: 'after launch',
        until: 1_800_000_000_000,
      });
    });

    it('keeps the park record across other edits, and clears it on unpark', async () => {
      const { db, team } = await seed();
      const l = await openLane(db, team.id, team.slug, 'nick', { title: 'later' });
      await updateLane(db, team.id, l.id, team.slug, park, 1, undefined, { actor: 'nick' });
      await updateLane(db, team.id, l.id, team.slug, { detail: 'more' }, 2, undefined, {
        actor: 'nick',
      });
      expect((await getLane(db, team.id, l.id, team.slug))!.parked?.reason).toBe('after launch');
      const open = (await updateLane(
        db,
        team.id,
        l.id,
        team.slug,
        { state: 'open' },
        3,
        undefined,
        {
          actor: 'nick',
        },
      ))!;
      expect(open.state).toBe('open');
      expect(open.parked).toBeUndefined();
    });
  });

  describe('the brief — parked lanes are counted, never offered (ADR 466)', async () => {
    it('drops parked lanes from up_next and reports parked_total', async () => {
      const { db, team } = await seed();
      await openLane(db, team.id, team.slug, 'nick', { title: 'now' });
      const later = await openLane(db, team.id, team.slug, 'nick', { title: 'later' });
      await updateLane(db, team.id, later.id, team.slug, park, 1, undefined, { actor: 'nick' });
      const brief = await deriveNext(db, team.id, team.slug, 'fifty');
      expect(brief.up_next.map((l) => l.title)).toEqual(['now']);
      expect(brief.parked_total).toBe(1);
    });
  });
});
