import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { consumeInvite, mintInvite, NODE_INVITE_TTL_MS } from './nodes.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('nodes.invite', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * Enrollment codes (ADR 328 §2) — trust-on-first-use, bounded by a short window, consumed under a
   * guarded CAS so two daemons racing one invite cannot both enroll.
   */

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    return { db, team };
  }

  describe('node invites (ADR 328 §2)', async () => {
    it('is single-use — the second consumer is refused', async () => {
      const { db, team } = await seed();
      const { invite } = await mintInvite(db, team.id, 'laptop', 'nick');

      expect(await consumeInvite(db, team.id, invite, 'node-a')).not.toBeNull();
      expect(await consumeInvite(db, team.id, invite, 'node-b')).toBeNull();

      // And the record says who won, so a second claim is answerable rather than merely denied.
      const row = await db.get('SELECT consumed_by FROM node_invites');
      expect(row?.consumed_by).toBe('node-a');
      await db.close();
    });

    it('refuses an expired code, and accepts the same code inside the window', async () => {
      const { db, team } = await seed();
      const t0 = 1_000_000;
      const { invite, expires_at } = await mintInvite(db, team.id, 'laptop', 'nick', t0);
      expect(expires_at).toBe(t0 + NODE_INVITE_TTL_MS);

      expect(
        await consumeInvite(db, team.id, invite, 'node-a', t0 + NODE_INVITE_TTL_MS + 1),
      ).toBeNull();
      expect(await consumeInvite(db, team.id, invite, 'node-a', t0 + 1)).not.toBeNull();
      await db.close();
    });

    it('refuses an unknown code', async () => {
      const { db, team } = await seed();
      await mintInvite(db, team.id, 'laptop', 'nick');
      expect(await consumeInvite(db, team.id, 'msinv_not-a-real-code', 'node-a')).toBeNull();
      await db.close();
    });

    it("refuses another team's code — an invite admits to the team that minted it", async () => {
      const db = await openStore();
      const mine = await createTeam(db, { slug: 'revive' });
      const other = await createTeam(db, { slug: 'elsewhere' });
      const { invite } = await mintInvite(db, mine.id, 'laptop', 'nick');

      expect(await consumeInvite(db, other.id, invite, 'node-a')).toBeNull();
      expect(await consumeInvite(db, mine.id, invite, 'node-a')).not.toBeNull();
      await db.close();
    });

    it('stores only the hash — the plaintext never reaches the table', async () => {
      const { db, team } = await seed();
      const { invite } = await mintInvite(db, team.id, 'laptop', 'nick');
      const rows = (await db.all('SELECT * FROM node_invites')) as Record<string, unknown>[];
      expect(JSON.stringify(rows)).not.toContain(invite);
      await db.close();
    });

    it('mints a code in the msinv_ namespace, distinct every time', async () => {
      const { db, team } = await seed();
      const a = (await mintInvite(db, team.id, 'laptop', 'nick')).invite;
      const b = (await mintInvite(db, team.id, 'laptop', 'nick')).invite;
      expect(a).toMatch(/^msinv_/);
      expect(b).not.toBe(a);
      await db.close();
    });
  });
});
