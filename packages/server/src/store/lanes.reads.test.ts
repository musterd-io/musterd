import type { Lane } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAuditByAction } from './audit.js';
import { decideReadVerdict, getLane, laneFieldDiff, openLane, updateLane } from './lanes.js';
import { sweepAbandonedAcceptance } from './laneSweep.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const FUTURE = '2999-01-01';
const PAST = '2001-01-01';

withDrivers('lane reads (ADR 644)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    await addMember(db, team, { name: 'nick', kind: 'human' });
    await addMember(db, team, { name: 'ryder', kind: 'agent' });
    return { db, team };
  }

  const open = (db: Driver, teamId: string, reads_on?: string) =>
    openLane(db, teamId, 'revive', 'ryder', {
      title: 'read',
      claim: true,
      ...(reads_on !== undefined ? { reads_on } : {}),
    });

  it('a lane opened with reads_on projects waiting, and overdue once the day has passed', async () => {
    const { db, team } = await seed();
    const later = await open(db, team.id, FUTURE);
    expect(later).toMatchObject({ reads_on: FUTURE, read_status: 'waiting' });
    const gone = await open(db, team.id, PAST);
    expect(gone.read_status).toBe('overdue');
  });

  it('a lane with no reads_on carries none of the three fields', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id);
    expect(lane).not.toHaveProperty('reads_on');
    expect(lane).not.toHaveProperty('read_status');
    expect(lane).not.toHaveProperty('read_verdict');
  });

  it('the day moves and clears by update; the change is audited as a lane field', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id, FUTURE);
    const moved = (await updateLane(
      db,
      team.id,
      lane.id,
      'revive',
      { reads_on: PAST },
      Date.now(),
      undefined,
      { actor: 'ryder' },
    ))!;
    expect(moved).toMatchObject({ reads_on: PAST, read_status: 'overdue' });
    const cleared = (await updateLane(db, team.id, lane.id, 'revive', { reads_on: null }))!;
    expect(cleared).not.toHaveProperty('reads_on');
    expect(cleared).not.toHaveProperty('read_status');
    expect(Object.keys(laneFieldDiff(lane, moved))).toEqual(['reads_on']);
  });

  it('stamps the verdict by the sender and the clock, derives read, and writes one row', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id, PAST);
    const given = (await updateLane(
      db,
      team.id,
      lane.id,
      'revive',
      { read_verdict: { outcome: 'met', note: 'hit rate above baseline' } },
      1_000,
      undefined,
      { actor: 'ryder' },
    ))!;
    expect(given.read_verdict).toEqual({
      outcome: 'met',
      note: 'hit rate above baseline',
      by: 'ryder',
      at: 1_000,
    });
    expect(given.read_status).toBe('read');
    const rows = await listAuditByAction(db, team.id, 'lane.read_recorded', 5);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
      lane: lane.id,
      reads_on: PAST,
      outcome: 'met',
      by: 'ryder',
      at: 1_000,
      previous_outcome: null,
    });
  });

  it('a later verdict replaces the earlier one and records what it replaced', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id, PAST);
    const audit = { actor: 'ryder' };
    await updateLane(
      db,
      team.id,
      lane.id,
      'revive',
      { read_verdict: { outcome: 'missed', note: 'a' } },
      1_000,
      undefined,
      audit,
    );
    const second = (await updateLane(
      db,
      team.id,
      lane.id,
      'revive',
      { read_verdict: { outcome: 'met', note: 'b' } },
      2_000,
      undefined,
      audit,
    ))!;
    expect(second.read_verdict).toMatchObject({ outcome: 'met', note: 'b', at: 2_000 });
    const rows = await listAuditByAction(db, team.id, 'lane.read_recorded', 5);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
      outcome: 'met',
      previous_outcome: 'missed',
    });
  });

  it('writes one row per verdict write, even for two writes at the same millisecond', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id, PAST);
    const audit = { actor: 'ryder' };
    const give = (outcome: 'met' | 'missed', note: string) =>
      updateLane(
        db,
        team.id,
        lane.id,
        'revive',
        { read_verdict: { outcome, note } },
        5_000,
        undefined,
        audit,
      );
    await give('missed', 'a');
    const second = (await give('met', 'b'))!;
    expect(second.read_verdict).toMatchObject({ outcome: 'met', note: 'b', at: 5_000 });
    // The same verdict sent again is still a write, and still one row.
    await give('met', 'b');
    const rows = await listAuditByAction(db, team.id, 'lane.read_recorded', 10);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => JSON.parse(r.detail!).previous_outcome).sort()).toEqual([
      'met',
      'missed',
      null,
    ]);
  });

  it('refuses a verdict on a lane that reads on no day, and one with no sender', async () => {
    const { db, team } = await seed();
    const plain = await open(db, team.id);
    await expect(
      updateLane(
        db,
        team.id,
        plain.id,
        'revive',
        { read_verdict: { outcome: 'met', note: 'x' } },
        Date.now(),
        undefined,
        { actor: 'ryder' },
      ),
    ).rejects.toThrow(/no reads_on/);
    const dated = await open(db, team.id, PAST);
    await expect(
      updateLane(db, team.id, dated.id, 'revive', { read_verdict: { outcome: 'met', note: 'x' } }),
    ).rejects.toThrow(/needs the seat/);
  });

  describe('decideReadVerdict: done is refused while a read has no verdict', () => {
    const lane = (extra: Partial<Lane>): Lane =>
      ({ id: 'L1', state: 'active', reads_on: PAST, ...extra }) as Lane;

    it('refuses done with validation, naming the day', () => {
      expect(() => decideReadVerdict(lane({}), { state: 'done' })).toThrow(
        expect.objectContaining({ code: 'validation', message: expect.stringContaining(PAST) }),
      );
    });

    it('lets done through when the verdict rides the same patch, is already recorded, or the day clears', () => {
      expect(() =>
        decideReadVerdict(lane({}), { state: 'done', read_verdict: { outcome: 'met', note: 'n' } }),
      ).not.toThrow();
      expect(() =>
        decideReadVerdict(lane({ read_verdict: { outcome: 'met', note: 'n', by: 'a', at: 1 } }), {
          state: 'done',
        }),
      ).not.toThrow();
      expect(() => decideReadVerdict(lane({}), { state: 'done', reads_on: null })).not.toThrow();
    });

    it('does not touch abandoned, other states, undated lanes or an already-closed lane', () => {
      expect(() => decideReadVerdict(lane({}), { state: 'abandoned' })).not.toThrow();
      expect(() => decideReadVerdict(lane({}), { state: 'awaiting_acceptance' })).not.toThrow();
      expect(() =>
        decideReadVerdict(lane({ reads_on: undefined }), { state: 'done' }),
      ).not.toThrow();
      expect(() => decideReadVerdict(lane({ state: 'done' }), { state: 'done' })).not.toThrow();
    });
  });

  it('an abandoned read with no verdict projects dropped', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id, PAST);
    const dropped = (await updateLane(db, team.id, lane.id, 'revive', {
      state: 'abandoned',
      abandon_reason: 'not needed',
    }))!;
    expect(dropped.read_status).toBe('dropped');
  });

  it('the abandoned-acceptance sweep leaves a lane whose read has no verdict', async () => {
    const { db, team } = await seed();
    const lane = await open(db, team.id, PAST);
    await updateLane(db, team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
    await db.run('UPDATE lanes SET updated_at = ? WHERE id = ?', [
      Date.now() - 10 * 24 * 3_600_000,
      lane.id,
    ]);
    expect(await sweepAbandonedAcceptance(db, team.id, 'revive', Date.now())).toEqual([]);
    expect((await getLane(db, team.id, lane.id, 'revive'))!.state).toBe('awaiting_acceptance');
  });
});
