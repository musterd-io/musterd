import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { listAudit } from '../store/audit.js';
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
 * ADR 623 §2-§4 (away channels 2d). `meta.channel_answer` says an answer came through a channel. It is
 * server-controlled: stripped from a client envelope, and never allowed to ride an `accept` or
 * `decline` even when the daemon composes it, because every consumer that treats a human accept as
 * authority (acceptance, hold proposals, policy review, handoff accept) sits behind that one door.
 */
withDrivers('route.channelAnswer', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent', role: '' })).row;
    return { db, team, nick, ada, ctx: stubCtx(db) };
  }

  const CHANNEL = { channel: 'slack', assurance: 'A1', decision: 'approve' };

  function env(team: string, from: string, id: string, act: string, meta: Record<string, unknown>) {
    return makeEnvelope({
      id,
      team,
      from,
      to: { kind: 'team' },
      act: act as never,
      body: 'x',
      meta,
    });
  }

  async function storedMeta(db: Driver, id: string): Promise<Record<string, unknown> | null> {
    const row = await db.get<{ meta: string | null }>('SELECT meta FROM messages WHERE id = ?', [
      id,
    ]);
    if (!row) return null;
    return row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  }

  it('strips a client-supplied channel_answer: a seat cannot mark its own reply as a channel answer', async () => {
    const { db, team, ada, ctx } = await seed();
    await routeEnvelope(
      ctx,
      team,
      ada,
      env('revive', 'ada', 'm1', 'message', { channel_answer: CHANNEL }),
    );
    const meta = await storedMeta(db, 'm1');
    expect(meta).not.toBeNull();
    expect(meta).not.toHaveProperty('channel_answer');
  });

  it('keeps channel_answer on a message the daemon composed: the legitimate A1 path', async () => {
    const { db, team, nick, ctx } = await seed();
    await routeEnvelope(
      ctx,
      team,
      nick,
      env('revive', 'nick', 'm2', 'message', { in_reply_to: 'ask-1', channel_answer: CHANNEL }),
      undefined,
      true,
    );
    expect(await storedMeta(db, 'm2')).toMatchObject({ channel_answer: CHANNEL });
  });

  for (const act of ['accept', 'decline'] as const) {
    it(`refuses a daemon-composed ${act} that carries channel_answer, writes nothing and audits it`, async () => {
      const { db, team, nick, ctx } = await seed();
      await expect(
        routeEnvelope(
          ctx,
          team,
          nick,
          env('revive', 'nick', `m-${act}`, act, { in_reply_to: 'ask-1', channel_answer: CHANNEL }),
          undefined,
          true,
        ),
      ).rejects.toSatisfy((e) => e instanceof MusterdError && e.code === 'forbidden');
      expect(await storedMeta(db, `m-${act}`)).toBeNull();
      const rows = (await listAudit(db, team.id)).filter(
        (r) => r.action === 'channel.answer.refused',
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ reason: 'assurance', act });
    });
  }

  it('a plain human accept is unchanged by the guard', async () => {
    const { db, team, nick, ctx } = await seed();
    await routeEnvelope(
      ctx,
      team,
      nick,
      env('revive', 'nick', 'm3', 'accept', { in_reply_to: 'ask-1' }),
    );
    expect(await storedMeta(db, 'm3')).toMatchObject({ in_reply_to: 'ask-1' });
  });
});
