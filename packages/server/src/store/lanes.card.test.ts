import type { LaneCard } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAuditByAction } from './audit.js';
import { backfillCards, CARD_CANDIDATES, pickCardPlace } from './laneCard.js';
import { getLane, openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

describe('pickCardPlace (ADR 751)', () => {
  it('is one of the candidates, and the same for the same lane and cell', () => {
    const a = pickCardPlace('01LANE', []);
    expect(CARD_CANDIDATES).toContainEqual(a);
    expect(pickCardPlace('01LANE', [])).toEqual(a);
  });

  it('spreads a cell out: each card takes the spot farthest from the others', () => {
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < CARD_CANDIDATES.length; i++)
      placed.push(pickCardPlace(`lane-${i}`, placed));
    // Twelve cards in twelve candidates: no two on one spot.
    expect(new Set(placed.map((p) => `${p.x},${p.y}`)).size).toBe(CARD_CANDIDATES.length);
  });

  it('starts different lanes in different spots of an empty cell', () => {
    const firsts = new Set(
      Array.from({ length: 40 }, (_, i) => JSON.stringify(pickCardPlace(`l${i}`, []))),
    );
    expect(firsts.size).toBeGreaterThan(4);
  });
});

describe('backfillCards (v134)', () => {
  it('places every lane on the board per cell, and none off it', () => {
    const row = (id: string, state: string, goal_id: string | null = 'g') => ({
      id,
      team_id: 't',
      goal_id,
      state,
      owner_seat: null,
      created_by: 'ada',
      updated_at: 5,
    });
    const out = backfillCards([
      row('a', 'open'),
      row('b', 'open'),
      row('c', 'parked'),
      row('d', 'abandoned'),
      row('e', 'ready_for_review'),
    ]);
    expect(out.map((u) => u.id)).toEqual(['a', 'b', 'e']);
    const [a, b] = out.map((u) => JSON.parse(u.card_json) as LaneCard);
    expect(a).not.toEqual(b);
    expect(a).toMatchObject({ by: 'ada', at: 5 });
  });
});

withDrivers('lane cards (ADR 751)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    await addMember(db, team, { name: 'ada', kind: 'agent' });
    await addMember(db, team, { name: 'cy', kind: 'agent' });
    return { db, team };
  }
  const update = (db: Driver, teamId: string, id: string, patch: object, actor = 'ada') =>
    updateLane(db, teamId, id, 'revive', patch, Date.now(), undefined, { actor });

  it('a new lane gets a card in its cell, put there by its opener', async () => {
    const { db, team } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'x', goal_id: 'g' });
    expect(lane.card).toMatchObject({ by: 'ada' });
    expect(CARD_CANDIDATES).toContainEqual({ x: lane.card!.x, y: lane.card!.y });
  });

  it('two lanes in one cell do not share a spot', async () => {
    const { db, team } = await seed();
    const a = await openLane(db, team.id, 'revive', 'ada', { title: 'a', goal_id: 'g' });
    const b = await openLane(db, team.id, 'revive', 'ada', { title: 'b', goal_id: 'g' });
    expect({ x: a.card!.x, y: a.card!.y }).not.toEqual({ x: b.card!.x, y: b.card!.y });
  });

  it('keeps its place on an edit that leaves the cell alone', async () => {
    const { db, team } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'x' });
    const edited = (await update(db, team.id, lane.id, { detail: 'more' }, 'cy'))!;
    expect(edited.card).toEqual(lane.card);
  });

  it('is re-placed, by the mover, when its column or goal changes', async () => {
    const { db, team } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'x' });
    const claimed = (await update(db, team.id, lane.id, { owner_seat: 'cy' }, 'cy'))!;
    expect(claimed.state).toBe('claimed');
    expect(claimed.card).toMatchObject({ by: 'cy' });
    const regoaled = (await update(db, team.id, lane.id, { goal_id: 'g2' }, 'ada'))!;
    expect(regoaled.card).toMatchObject({ by: 'ada' });
  });

  it('a named place wins, and moves the card within its cell', async () => {
    const { db, team } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'x' });
    const moved = (await update(db, team.id, lane.id, { card: { x: 0.3, y: 0.9 } }, 'cy'))!;
    expect(moved.card).toMatchObject({ x: 0.3, y: 0.9, by: 'cy' });
    expect(moved.state).toBe('open');
    const both = (await update(
      db,
      team.id,
      lane.id,
      { state: 'claimed', owner_seat: 'cy', card: { x: 0.1, y: 0.1 } },
      'cy',
    ))!;
    expect(both.card).toMatchObject({ x: 0.1, y: 0.1, by: 'cy' });
  });

  it('an abandon throws the card away, and a place on a card-less lane is refused', async () => {
    const { db, team } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'x' });
    const dropped = (await update(db, team.id, lane.id, {
      state: 'abandoned',
      abandon_reason: 'superseded',
    }))!;
    expect(dropped.card ?? null).toBeNull();
    await expect(update(db, team.id, lane.id, { card: { x: 0.5, y: 0.5 } })).rejects.toThrow(
      /no card/,
    );
    expect((await getLane(db, team.id, lane.id, 'revive'))!.card ?? null).toBeNull();
  });

  it('records each move as a lane.updated change of `card`', async () => {
    const { db, team } = await seed();
    const lane = await openLane(db, team.id, 'revive', 'ada', { title: 'x' });
    await update(db, team.id, lane.id, { card: { x: 0.4, y: 0.4 } }, 'cy');
    const [row] = await listAuditByAction(db, team.id, 'lane.updated');
    const detail = JSON.parse(row!.detail!) as {
      fields: string[];
      changes: { card: { to: LaneCard } };
    };
    expect(detail.fields).toEqual(['card']);
    expect(detail.changes.card.to).toMatchObject({ x: 0.4, y: 0.4, by: 'cy' });
  });
});
