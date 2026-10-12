import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import {
  filterLanes,
  getLane,
  laneHoldingSourceRef,
  listLanes,
  openLane,
  updateLane,
} from './lanes.js';
import { createTeam } from './teams.js';

/**
 * ADR 561 — `source_ref` is a lane field, and a team holds at most one lane per ref that is neither
 * done nor abandoned. The store refuses the second inside its transaction (409 `conflict`).
 */

let openStore: () => Promise<Driver>;

async function seed(slug = 'bravo') {
  const db = await openStore();
  const team = await createTeam(db, { slug });
  return { db, team };
}

async function refusal(fn: () => Promise<unknown>): Promise<MusterdError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MusterdError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

withDrivers('source_ref', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  describe('one open lane per ref (ADR 561)', () => {
    it('stores the ref and reads it back', async () => {
      const { db, team } = await seed();
      const l = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'acme/app#1',
      });
      expect(l.source_ref).toBe('acme/app#1');
      expect((await getLane(db, team.id, l.id, team.slug))?.source_ref).toBe('acme/app#1');
      const plain = await openLane(db, team.id, team.slug, 'dolly', { title: 'b' });
      expect(plain.source_ref).toBeUndefined();
      await db.close();
    });

    it('refuses a second open lane on the same ref, naming the holder', async () => {
      const { db, team } = await seed();
      const first = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'acme/app#1',
      });
      const err = await refusal(() =>
        openLane(db, team.id, team.slug, 'dolly', { title: 'again', source_ref: 'acme/app#1' }),
      );
      expect(err.code).toBe('conflict');
      expect(err.message).toBe(`source_ref "acme/app#1" already belongs to lane ${first.id}`);
      expect(await listLanes(db, team.id, team.slug)).toHaveLength(1);
      await db.close();
    });

    it('a done or abandoned lane keeps its ref as history, and the ref is free again', async () => {
      const { db, team } = await seed();
      const first = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'acme/app#1',
      });
      await updateLane(db, team.id, first.id, team.slug, {
        state: 'abandoned',
        abandon_reason: 'closed upstream',
      });
      expect((await getLane(db, team.id, first.id, team.slug))?.source_ref).toBe('acme/app#1');
      const second = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'reopened issue',
        source_ref: 'acme/app#1',
      });
      expect(await laneHoldingSourceRef(db, team.id, 'acme/app#1')).toEqual({ id: second.id });
      await db.close();
    });

    it('refuses reopening a closed lane onto a ref an open lane now holds', async () => {
      const { db, team } = await seed();
      const first = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'acme/app#1',
      });
      await updateLane(db, team.id, first.id, team.slug, {
        state: 'abandoned',
        abandon_reason: 'x',
      });
      const second = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'b',
        source_ref: 'acme/app#1',
      });
      const err = await refusal(() =>
        updateLane(db, team.id, first.id, team.slug, { state: 'open' }),
      );
      expect(err.code).toBe('conflict');
      expect(err.message).toContain(`already belongs to lane ${second.id}`);
      expect((await getLane(db, team.id, first.id, team.slug))?.state).toBe('abandoned');
      await db.close();
    });

    it('refuses an update onto a held ref; a patch with its own ref is fine', async () => {
      const { db, team } = await seed();
      const a = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'acme/app#1',
      });
      const b = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'b',
        source_ref: 'acme/app#2',
      });
      const err = await refusal(() =>
        updateLane(db, team.id, b.id, team.slug, { source_ref: 'acme/app#1' }),
      );
      expect(err.code).toBe('conflict');
      expect(err.message).toContain(a.id);
      const same = await updateLane(db, team.id, a.id, team.slug, {
        source_ref: 'acme/app#1',
        title: 'renamed',
      });
      expect(same?.title).toBe('renamed');
      const moved = await updateLane(db, team.id, b.id, team.slug, { source_ref: 'acme/app#3' });
      expect(moved?.source_ref).toBe('acme/app#3');
      await db.close();
    });

    it('two teams may hold the same ref', async () => {
      const { db, team } = await seed();
      const other = await createTeam(db, { slug: 'charlie' });
      await openLane(db, team.id, team.slug, 'dolly', { title: 'a', source_ref: 'ENG-1' });
      const there = await openLane(db, other.id, other.slug, 'dolly', {
        title: 'a',
        source_ref: 'ENG-1',
      });
      expect(there.source_ref).toBe('ENG-1');
      await db.close();
    });

    it('filters the board by ref', async () => {
      const { db, team } = await seed();
      const a = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'ENG-1',
      });
      await openLane(db, team.id, team.slug, 'dolly', { title: 'b', source_ref: 'ENG-2' });
      await openLane(db, team.id, team.slug, 'dolly', { title: 'c' });
      const board = await listLanes(db, team.id, team.slug);
      expect(filterLanes(board, { sourceRef: 'ENG-1' }).map((l) => l.id)).toEqual([a.id]);
      expect(
        (await listLanes(db, team.id, team.slug, { sourceRef: 'ENG-1' })).map((l) => l.id),
      ).toEqual([a.id]);
      await db.close();
    });

    it('a change of ref is audited like any field', async () => {
      const { db, team } = await seed();
      const a = await openLane(db, team.id, team.slug, 'dolly', {
        title: 'a',
        source_ref: 'ENG-1',
      });
      await updateLane(
        db,
        team.id,
        a.id,
        team.slug,
        { source_ref: 'ENG-9' },
        Date.now(),
        undefined,
        {
          actor: 'dolly',
        },
      );
      const rows = await db.all<{ action: string; detail: string }>(
        "SELECT action, detail FROM audit WHERE target = ? AND action IN ('lane.opened','lane.updated') ORDER BY ts, id",
        [a.id],
      );
      expect(JSON.parse(rows[0]!.detail).source_ref).toBe('ENG-1');
      expect(JSON.parse(rows[1]!.detail).changes.source_ref).toEqual({
        from: 'ENG-1',
        to: 'ENG-9',
      });
      await db.close();
    });
  });
});
