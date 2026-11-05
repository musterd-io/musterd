import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from '../store/members.js';
import { reportLive } from '../store/polls.js';
import { createTeam } from '../store/teams.js';
import { closeLine, openAndAnnounce, sweepPolls } from './pollWatch.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

const T = 1_800_000_000_000;
const SPEC = { question: 'What next?', options: ['Camera', 'Ask the team'], minutes: 1 };

withDrivers('pollWatch (ADR 807)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    await reportLive(db, team.id, true, T);
    return { db, team, nick, ctx: stubCtx(db) };
  }

  it('closes a poll at its deadline and resolves the opening message with the record', async () => {
    const { db, team, nick, ctx } = await seed();
    await openAndAnnounce(ctx, team, nick, SPEC, 'A2', T);
    expect(await sweepPolls(ctx, T + 30_000)).toBe(0);
    expect(await sweepPolls(ctx, T + 60_000)).toBe(1);
    expect(await sweepPolls(ctx, T + 61_000)).toBe(0);
    const rows = await db.all<{ act: string; body: string }>(
      'SELECT act, body FROM messages WHERE meta LIKE \'%"poll"%\' ORDER BY created_at',
    );
    expect(rows.map((r) => r.act)).toEqual(['message', 'resolve']);
    expect(rows[1]!.body).toBe('[poll] closed with no votes: What next?');
  });

  it('closes as interrupted once the stream has gone silent for the grace', async () => {
    const { team, nick, ctx } = await seed();
    await openAndAnnounce(ctx, team, nick, { ...SPEC, minutes: 15 }, 'A2', T);
    expect(await sweepPolls(ctx, T + 89_000)).toBe(0);
    expect(await sweepPolls(ctx, T + 90_000)).toBe(1);
  });

  it('says each outcome in one plain line', () => {
    const base = {
      state: 'closed' as const,
      id: 'p',
      question: 'Q?',
      options: ['a', 'b'],
      opened_by: 'nick',
      opened_at: 0,
      closes_at: 1,
      counts: [3, 3],
      voters: 6,
      closed_at: 2,
    };
    expect(closeLine({ ...base, end: 'deadline', winners: [0] })).toBe(
      '[poll] closed (6 votes): Q? → 1 · a',
    );
    expect(closeLine({ ...base, end: 'deadline', winners: [0, 1] })).toBe(
      '[poll] closed, a tie (6 votes): Q? → 1 · a and 2 · b',
    );
    expect(closeLine({ ...base, end: 'cancelled', winners: [] })).toBe('[poll] cancelled: Q?');
    expect(closeLine({ ...base, end: 'interrupted', winners: [0, 1] })).toBe(
      '[poll] interrupted when the stream dropped (6 votes): Q?',
    );
  });
});
