import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;

const ID = '01M0XINSIGHT0000000000000000';

/** Minimal ctx: the cap guard fires before any persistence, and the happy path only needs a
 *  no-op hub (deliver/broadcastFirehose) beside the db. */
function stubCtx(db: Database): Ctx {
  return {
    db: db,
    rosterRoots: [],
    config: {} as Ctx['config'],
    hub: {
      deliver: () => false,
      broadcastFirehose: () => 0,
    } as unknown as Ctx['hub'],
  };
}

/**
 * ADR 327: the insight act's 2048-byte body cap is enforced server-side on the one
 * validate→persist→deliver path (actMetaRules sees only {act, thread, meta}, never body).
 */
withDrivers('route.insight', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('insight body cap', async () => {
    it('rejects an insight whose body exceeds 2048 bytes', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'dawn' });
      const { row: sender } = await addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });

      const env = makeEnvelope({
        id: ID,
        team: team.slug,
        from: sender.name,
        to: { kind: 'team' },
        act: 'insight',
        body: 'x'.repeat(2049),
        meta: { headline: 'over the line' },
      });

      await expect(routeEnvelope(stubCtx(db), team, sender, env)).rejects.toThrowError(
        new MusterdError('validation', 'act "insight" body is limited to 2048 bytes'),
      );
    });

    it('rejects an insight with an empty or whitespace-only body (lane 01M50C7QWJ)', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'dawn' });
      const { row: sender } = await addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });

      for (const body of ['', '   ']) {
        const env = makeEnvelope({
          id: ID,
          team: team.slug,
          from: sender.name,
          to: { kind: 'team' },
          act: 'insight',
          body,
          meta: { headline: 'headline with no finding' },
        });
        await expect(routeEnvelope(stubCtx(db), team, sender, env)).rejects.toThrowError(
          new MusterdError('validation', 'act "insight" body must not be empty'),
        );
      }
    });

    it('accepts an insight at the cap boundary and counts bytes, not chars', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'dawn' });
      const { row: sender } = await addMember(db, team, { name: 'ghost', kind: 'agent', role: '' });

      // 1024 two-byte chars = 2048 bytes: exactly at the cap, must pass.
      const env = makeEnvelope({
        id: ID,
        team: team.slug,
        from: sender.name,
        to: { kind: 'team' },
        act: 'insight',
        body: 'é'.repeat(1024),
        meta: { headline: 'at the cap' },
      });
      await expect(routeEnvelope(stubCtx(db), team, sender, env)).resolves.not.toBeNull();
    });
  });
});
