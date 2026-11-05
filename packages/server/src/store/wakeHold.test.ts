import { describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import { attach, listReclaimableMemberIds, release } from './presence.js';
import { createTeam } from './teams.js';
import { releaseWakeHold } from './wakeHold.js';

/** ADR 804: a settled wake releases its reclaim hold, so the act lane's next wake is not held by it. */
withDrivers('wakeHold', (openStore: () => Promise<Driver>) => {
  describe('releaseWakeHold (ADR 804)', () => {
    it('ends the reclaim hold of the rows this lease holds, and no other', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const bo = (await addMember(db, team, { name: 'Bo', kind: 'agent' })).row;
      const wake = await attach(db, ada.id, 'claude-code', 'c1', { wake_lease: 'L1' });
      const other = await attach(db, bo.id, 'claude-code', 'c2', { wake_lease: 'L2' });
      await release(db, wake.id, 45_000);
      await release(db, other.id, 45_000);
      const now = Date.now();
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set([ada.id, bo.id]));

      const lease = { id: 'L1', member_id: ada.id, created_at: now - 60_000 };
      expect(await releaseWakeHold(db, lease, now)).toBe(1);
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set([bo.id]));
      // Idempotent: nothing left to release for this lease.
      expect(await releaseWakeHold(db, lease, now)).toBe(0);
    });

    it("releases the wake's hook sessions too — parked rows of the seat seen since the lease began", async () => {
      // The SessionEnd hook claims as the seat for ~80 ms with no lease on its row, and its close is
      // the last before the report; the smoke pair of 2026-11-05 showed its 45 s hold holding the
      // next wake with the lease-only release in place.
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const leaseStart = Date.now() - 30_000;
      const wake = await attach(db, ada.id, 'claude-code', 'c1', { wake_lease: 'L1' });
      const hook = await attach(db, ada.id, 'cli', 'c2', {});
      await release(db, wake.id, 45_000);
      await release(db, hook.id, 45_000);
      const now = Date.now();
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set([ada.id]));
      expect(
        await releaseWakeHold(db, { id: 'L1', member_id: ada.id, created_at: leaseStart }, now),
      ).toBe(2);
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set());
    });

    it('leaves a hold parked before the wake began', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const old = await attach(db, ada.id, 'claude-code', 'c0', {});
      await release(db, old.id, 600_000);
      const now = Date.now();
      // The lease was minted after that row was last seen: not this wake's.
      expect(
        await releaseWakeHold(db, { id: 'L9', member_id: ada.id, created_at: now + 1_000 }, now),
      ).toBe(0);
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set([ada.id]));
    });

    it('leaves a live session alone — only a parked hold ends', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      await attach(db, ada.id, 'claude-code', 'c1', { wake_lease: 'L1' });
      expect(await releaseWakeHold(db, { id: 'L1', member_id: ada.id, created_at: 0 })).toBe(0);
      const row = await db.get<{ held_until: number | null; conn_id: string | null }>(
        'SELECT held_until, conn_id FROM presence WHERE member_id = ?',
        [ada.id],
      );
      expect(row).toEqual({ held_until: null, conn_id: 'c1' });
    });
  });
});
