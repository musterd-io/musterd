import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

/**
 * ADR 807 §9: `meta.poll` is the daemon's record of a Twitch poll — who asked, the counts, the winner.
 * A client copy would let any member forge a poll result that reads as the daemon's, so it is stripped
 * from every envelope the daemon did not compose. The act still lands, as plain prose.
 */
withDrivers('route.poll', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  const OPEN = {
    state: 'open',
    id: '01M6POLL0000000000000000AA',
    question: 'What should team revive work on next?',
    options: ['Director camera', 'Ask the team'],
    opened_by: 'nick',
    opened_at: 1,
    closes_at: 2,
  };

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent', role: '' })).row;
    return { db, team, nick, ada, ctx: stubCtx(db) };
  }

  const env = (from: string, id: string) =>
    makeEnvelope({
      id,
      team: 'revive',
      from,
      to: { kind: 'team' },
      act: 'message',
      body: 'a poll',
      meta: { poll: OPEN },
    });

  async function storedMeta(db: Driver, id: string): Promise<Record<string, unknown> | null> {
    const row = await db.get<{ meta: string | null }>('SELECT meta FROM messages WHERE id = ?', [
      id,
    ]);
    if (!row) return null;
    return row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  }

  it('strips a client-sent poll record, from a seat and from a person alike', async () => {
    const { db, team, ada, nick, ctx } = await seed();
    await routeEnvelope(ctx, team, ada, env('ada', 'p1'));
    await routeEnvelope(ctx, team, nick, env('nick', 'p2'));
    for (const id of ['p1', 'p2']) {
      const meta = await storedMeta(db, id);
      expect(meta).not.toBeNull();
      expect(meta).not.toHaveProperty('poll');
    }
  });

  it('keeps the poll record on an envelope the daemon composed', async () => {
    const { db, team, nick, ctx } = await seed();
    await routeEnvelope(ctx, team, nick, env('nick', 'p3'), undefined, true);
    expect(await storedMeta(db, 'p3')).toHaveProperty('poll');
  });
});
