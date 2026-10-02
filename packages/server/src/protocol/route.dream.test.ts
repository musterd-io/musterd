import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { addMember } from '../store/members.js';
import { attach } from '../store/presence.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: {} as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

/**
 * Goal dreaming, lane 2 (ADR 494): a seat whose live presence is a `dream` one sends insights and
 * nothing else. The fence sits on the one validate→persist→deliver path, so no surface skips it.
 */
withDrivers('route.dream', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed(provenance: 'dream' | 'wake') {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const { row: sender } = await addMember(db, team, { name: 'ryder', kind: 'agent', role: '' });
    await addMember(db, team, { name: 'nick', kind: 'human', role: '' });
    await attach(db, sender.id, 'claude-code', null, { provenance });
    return { db, team, sender };
  }

  let n = 0;
  const env = (team: string, act: string, to: 'team' | 'nick' = 'team') =>
    makeEnvelope({
      id: `01M0XDREAM${String(n++).padStart(16, '0')}`,
      team,
      from: 'ryder',
      to: to === 'team' ? { kind: 'team' } : { kind: 'member', name: to },
      act: act as 'message',
      body: 'x',
      meta:
        act === 'insight'
          ? { headline: 'h' }
          : act === 'ask'
            ? { species: 'consult', tier: 'blocking' }
            : null,
    });

  describe('the dream fence on send', async () => {
    it('lets a dreaming seat save an insight, stamped from_provenance dream', async () => {
      const { db, team, sender } = await seed('dream');
      await expect(
        routeEnvelope(stubCtx(db), team, sender, env(team.slug, 'insight')),
      ).resolves.not.toBeNull();
      const row = await db.get<{ from_provenance: string }>(
        `SELECT from_provenance FROM messages WHERE act = 'insight'`,
      );
      expect(row?.from_provenance).toBe('dream');
    });

    it.each(['message', 'status_update'])('refuses a dreaming seat a %s', async (act) => {
      const { db, team, sender } = await seed('dream');
      await expect(
        routeEnvelope(stubCtx(db), team, sender, env(team.slug, act)),
      ).rejects.toThrowError(
        new MusterdError('forbidden', `a dream sends only insight acts, not ${act}`),
      );
      expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))?.n).toBe(0);
    });

    it('refuses a dreaming seat an ask to a human — a dream never rings anyone', async () => {
      const { db, team, sender } = await seed('dream');
      await expect(
        routeEnvelope(stubCtx(db), team, sender, env(team.slug, 'ask', 'nick')),
      ).rejects.toThrowError(/only insight acts, not ask/);
    });

    it('leaves a wake session alone', async () => {
      const { db, team, sender } = await seed('wake');
      await expect(
        routeEnvelope(stubCtx(db), team, sender, env(team.slug, 'message')),
      ).resolves.not.toBeNull();
    });
  });
});
