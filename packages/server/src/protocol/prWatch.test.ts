import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAuditByAction } from '../store/audit.js';
import { openLane, updateLane } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import type { ListedPr } from './prState.js';
import { prEventFor, sweepTeamPrs } from './prWatch.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: {
      deliver: () => false,
      deliverToAdmins: () => 0,
      broadcastFirehose: () => 0,
    } as unknown as Ctx['hub'],
  };
}

const pr = (over: Partial<ListedPr> = {}): ListedPr => ({
  number: 3660,
  branch: 'feat/x',
  state: 'open',
  checks: 'pending',
  url: undefined,
  ...over,
});

describe('prEventFor (ADR 779 §4)', () => {
  it('merged once; red once until green; green only after red', () => {
    expect(prEventFor(pr({ state: 'merged' }), new Set())).toBe('merged');
    expect(prEventFor(pr({ state: 'merged' }), new Set(['merged']))).toBeNull();
    expect(prEventFor(pr({ checks: 'red' }), new Set())).toBe('ci_red');
    expect(prEventFor(pr({ checks: 'red' }), new Set(['ci_red']))).toBeNull();
    expect(prEventFor(pr({ checks: 'green' }), new Set())).toBeNull();
    expect(prEventFor(pr({ checks: 'green' }), new Set(['ci_red']))).toBe('ci_green');
    expect(prEventFor(pr({ checks: 'red' }), new Set(['ci_red', 'ci_green']))).toBe('ci_red');
    expect(prEventFor(pr({ state: 'closed', checks: 'red' }), new Set())).toBeNull();
  });
});

withDrivers('the PR watch', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    await addMember(db, team, { name: 'nick', kind: 'human' });
    await addMember(db, team, { name: 'ryder', kind: 'agent', role: '' });
    const lane = await openLane(db, team.id, 'revive', 'ryder', {
      title: 'ledger cache',
      claim: true,
    });
    await updateLane(db, team.id, lane.id, 'revive', { branch: 'feat/x' });
    return { db, team, lane, ctx: stubCtx(db) };
  }

  const gh = (rows: object[]) => async () => JSON.stringify(rows);
  const row = (state: string, conclusion: string) => ({
    number: 3660,
    headRefName: 'feat/x',
    state,
    statusCheckRollup: [{ conclusion }],
    url: 'https://github.com/musterd-io/musterd/pull/3660',
  });

  async function events(db: Driver, teamId: string) {
    return db.all<{ meta: string }>(
      "SELECT meta FROM messages WHERE team_id = ? AND json_extract(meta, '$.pr_event') IS NOT NULL ORDER BY ts, id",
      [teamId],
    );
  }

  it('tells the owner once that the PR merged, across sweeps', async () => {
    const { db, team, lane, ctx } = await seed();
    expect(await sweepTeamPrs(ctx, team, 1_000, gh([row('MERGED', 'SUCCESS')]))).toBe(1);
    expect(await sweepTeamPrs(ctx, team, 61_000, gh([row('MERGED', 'SUCCESS')]))).toBe(0);
    const ev = await events(db, team.id);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.meta).pr_event).toMatchObject({
      lane: lane.id,
      pr: 3660,
      state: 'merged',
    });
    const to = await db.get<{ name: string }>(
      "SELECT mem.name FROM messages m JOIN members mem ON mem.id = m.to_member WHERE json_extract(m.meta, '$.pr_event') IS NOT NULL",
    );
    expect(to?.name).toBe('ryder');
  });

  it('red, then green, then red again is three events', async () => {
    const { db, team, ctx } = await seed();
    await sweepTeamPrs(ctx, team, 1_000, gh([row('OPEN', 'FAILURE')]));
    await sweepTeamPrs(ctx, team, 2_000, gh([row('OPEN', 'FAILURE')]));
    await sweepTeamPrs(ctx, team, 3_000, gh([row('OPEN', 'SUCCESS')]));
    await sweepTeamPrs(ctx, team, 4_000, gh([row('OPEN', 'FAILURE')]));
    const states = (await events(db, team.id)).map((e) => JSON.parse(e.meta).pr_event.state);
    expect(states).toEqual(['ci_red', 'ci_green', 'ci_red']);
  });

  it('without gh it sends nothing and says so at most hourly', async () => {
    const { db, team, ctx } = await seed();
    const noGh = () =>
      Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    await sweepTeamPrs(ctx, team, 1_000, noGh);
    await sweepTeamPrs(ctx, team, 61_000, noGh);
    expect(await events(db, team.id)).toHaveLength(0);
    expect(await listAuditByAction(db, team.id, 'pr_watch.unavailable', 5)).toHaveLength(1);
  });
});
