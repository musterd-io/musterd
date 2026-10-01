import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { seedDawn } from '../db/seed.js';
import { withDrivers } from '../db/testing.js';
import {
  consumeGrant,
  issueGrant,
  listGrants,
  refreshGrant,
  revokeGrant,
  validateGrant,
} from './grants.js';

let openStore: () => Promise<Driver>;

withDrivers('grants', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function setup() {
    const db = await openStore();
    const { teamId } = await seedDawn(db);
    return { db, teamId };
  }

  describe('grants store (ADR 076)', async () => {
    it('mints an msgr_ token, stores only its hash, and validates by token', async () => {
      const { db, teamId } = await setup();
      const { grant, token } = await issueGrant(
        db,
        teamId,
        { scope: 'seat', target: 'Ada', lifetime: 'standing' },
        'nick',
      );
      expect(token).toMatch(/^msgr_/);
      // the plaintext is never stored — only the hash
      const stored = await db.get('SELECT token_hash FROM grants WHERE id = ?', [grant.id]);
      expect(stored?.token_hash).toBeTruthy();
      expect(stored?.token_hash).not.toBe(token);
      const v = await validateGrant(db, teamId, token);
      expect(v.ok).toBe(true);
    });

    it('a once grant is single_use and refuses after consumption', async () => {
      const { db, teamId } = await setup();
      const { grant, token } = await issueGrant(
        db,
        teamId,
        { scope: 'seat', target: 'Ada', lifetime: 'once' },
        null,
      );
      expect(grant.single_use).toBe(true);
      expect((await validateGrant(db, teamId, token)).ok).toBe(true);
      await consumeGrant(db, grant.id);
      const after = await validateGrant(db, teamId, token);
      expect(after).toEqual({ ok: false, reason: 'revoked' });
    });

    it('a ttl grant refuses once expired', async () => {
      const { db, teamId } = await setup();
      const { token } = await issueGrant(
        db,
        teamId,
        { scope: 'role', target: 'backend', lifetime: 'ttl', ttl_hours: -1 }, // already past
        null,
      );
      expect(await validateGrant(db, teamId, token)).toEqual({ ok: false, reason: 'expired' });
    });

    it('revoke invalidates a standing grant; an unknown token is not_found', async () => {
      const { db, teamId } = await setup();
      const { grant, token } = await issueGrant(
        db,
        teamId,
        { scope: 'seat', target: 'Ada', lifetime: 'standing' },
        'nick',
      );
      expect(await revokeGrant(db, teamId, grant.id)).toBe(true);
      expect(await revokeGrant(db, teamId, grant.id)).toBe(false); // already revoked
      expect(await validateGrant(db, teamId, token)).toEqual({ ok: false, reason: 'revoked' });
      expect(await validateGrant(db, teamId, 'msgr_nope')).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });

    it('lists a team grants newest-first (public shape, no hash)', async () => {
      const { db, teamId } = await setup();
      await issueGrant(db, teamId, { scope: 'seat', target: 'Ada', lifetime: 'standing' }, 'nick');
      await issueGrant(db, teamId, { scope: 'seat', target: 'Lin', lifetime: 'once' }, 'nick');
      const grants = await listGrants(db, teamId);
      expect(grants).toHaveLength(2);
      expect(grants[0]).not.toHaveProperty('token_hash'); // public shape, no secret
      expect(grants.map((g) => g.target).sort()).toEqual(['Ada', 'Lin']);
    });

    // ADR 087: a resume token is a ttl grant refreshed on each occupy so an active seat never expires.
    it('refreshGrant bumps a ttl grant expires_at forward', async () => {
      const { db, teamId } = await setup();
      const { grant } = await issueGrant(
        db,
        teamId,
        { scope: 'seat', target: 'Ada', lifetime: 'ttl', ttl_hours: 1 },
        'nick',
      );
      const before = grant.expires_at!;
      expect(before).toBeGreaterThan(Date.now());
      await refreshGrant(db, grant.id, 24 * 3_600_000); // 24h window
      const after = await db.get('SELECT expires_at FROM grants WHERE id = ?', [grant.id]);
      expect(after!.expires_at).toBeGreaterThan(before);
    });

    it('refreshGrant is a no-op for a single_use (once) grant and a revoked grant', async () => {
      const { db, teamId } = await setup();
      const once = await issueGrant(
        db,
        teamId,
        { scope: 'seat', target: 'Ada', lifetime: 'once' },
        'nick',
      );
      // once grants have no expires_at; refresh must not create one (they aren't resume tokens)
      await refreshGrant(db, once.grant.id, 24 * 3_600_000);
      const onceRow = await db.get('SELECT expires_at FROM grants WHERE id = ?', [once.grant.id]);
      expect(onceRow!.expires_at).toBeNull();

      const ttl = await issueGrant(
        db,
        teamId,
        { scope: 'seat', target: 'Lin', lifetime: 'ttl', ttl_hours: 1 },
        'nick',
      );
      await revokeGrant(db, teamId, ttl.grant.id);
      const before = ttl.grant.expires_at!;
      await refreshGrant(db, ttl.grant.id, 999 * 3_600_000);
      const revoked = await db.get('SELECT expires_at FROM grants WHERE id = ?', [ttl.grant.id]);
      expect(revoked!.expires_at).toBe(before); // untouched — a revoked grant can't be resurrected
    });
  });
});
