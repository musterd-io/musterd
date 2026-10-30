import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { recordLaneClose } from './laneClose.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('laneClose.workerFamily', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  /**
   * Finding 020's 9 rows: the close edge derived `worker_family` from the owner's LIVE
   * presence, so a worker whose seat had gone offline by close time (mason's resident seat
   * was halted mid-window) recorded `unknown` — while the submit's own ready row already
   * carried the family attested at decision time. The close now falls back to that recorded
   * value, and says so in `worker_family_provenance`; where nothing attested the worker,
   * `unknown` stays, because an abstention is a fact and a guess is not (ADR 173).
   */
  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    await addMember(db, team, { name: 'nick', kind: 'human' });
    await addMember(db, team, { name: 'izzo', kind: 'agent' });
    await addMember(db, team, { name: 'ryder', kind: 'agent' });
    return { db, team };
  }

  async function closeRows(db: ReturnType<typeof openDb>, laneId: string) {
    return (
      await db.all(`SELECT detail FROM audit WHERE action = 'lane.closed' AND target = ?`, [laneId])
    ).map((r) => JSON.parse(r.detail) as Record<string, unknown>);
  }

  async function closeWithReadyFamily(
    db: ReturnType<typeof openDb>,
    teamId: string,
    opts: { owner: string; readyFamily?: string },
  ) {
    const lane = await openLane(db, teamId, 'revive', opts.owner, {
      title: 'worker family lane',
      claim: true,
    });
    if (opts.readyFamily !== undefined) {
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
         VALUES (?, ?, ?, ?, 'lane.ready_for_review', ?, 'allow', ?, ?)`,
        [
          `ready-${lane.id}`,
          teamId,
          Date.now(),
          opts.owner,
          lane.id,
          JSON.stringify({
            lane: lane.id,
            review_selection: { worker_family: opts.readyFamily, selected: null, candidates: [] },
          }),
          Date.now(),
        ],
      );
    }
    await updateLane(db, teamId, lane.id, 'revive', { state: 'awaiting_acceptance' });
    const before = { ...lane, state: 'awaiting_acceptance' as const };
    await recordLaneClose(db, teamId, { name: 'ryder', kind: 'agent' }, before, {
      ...before,
      state: 'done' as const,
    });
    return lane;
  }

  it('carries the submit-recorded family when the worker is no longer live at close', async () => {
    const { db, team } = await seed();
    const lane = await closeWithReadyFamily(db, team.id, { owner: 'izzo', readyFamily: 'claude' });

    const [close] = await closeRows(db, lane.id);
    expect(close?.['worker_family']).toBe('claude');
    expect(close?.['worker_family_provenance']).toBe('ready_row');
  });

  it('stays unknown, with no provenance, when nothing ever attested the worker', async () => {
    const { db, team } = await seed();
    const lane = await closeWithReadyFamily(db, team.id, { owner: 'izzo' });

    const [close] = await closeRows(db, lane.id);
    expect(close?.['worker_family']).toBe('unknown');
    expect(close).not.toHaveProperty('worker_family_provenance');
  });

  it('does not treat a ready row that itself abstained as evidence', async () => {
    const { db, team } = await seed();
    const lane = await closeWithReadyFamily(db, team.id, { owner: 'izzo', readyFamily: 'unknown' });

    const [close] = await closeRows(db, lane.id);
    expect(close?.['worker_family']).toBe('unknown');
    expect(close).not.toHaveProperty('worker_family_provenance');
  });

  it('lets the live family win: a human owner reads human, never the ready row', async () => {
    const { db, team } = await seed();
    const lane = await closeWithReadyFamily(db, team.id, { owner: 'nick', readyFamily: 'claude' });

    const [close] = await closeRows(db, lane.id);
    expect(close?.['worker_family']).toBe('human');
    expect(close).not.toHaveProperty('worker_family_provenance');
  });
});
