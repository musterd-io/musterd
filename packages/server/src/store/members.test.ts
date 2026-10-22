import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  addMember,
  bindMemberAccount,
  getMemberByName,
  leaveMember,
  memberByAccount,
  sweepExpiredMembers,
} from './members.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/**
 * Cosmetic expiry sweep (ADR 459 §4): members past `lifecycle_until` read as departed on the
 * roster. Auth already refused them — the sweep changes no decision, only `left_at`.
 */
withDrivers('members', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('sweepExpiredMembers (ADR 459 §4)', async () => {
    async function freshTeam() {
      const db = await openStore();
      return { db, team: await createTeam(db, { slug: 'sweep-t' }) };
    }

    it('marks expired members left_at and returns them, leaving everyone else alone', async () => {
      const { db, team } = await freshTeam();
      const past = Date.now() - 1000;
      const { row: gone } = await addMember(db, team, {
        name: 'gone',
        kind: 'human',
        lifecycle: 'until' as const,
        lifecycleUntil: past,
      });
      const { row: staying } = await addMember(db, team, { name: 'staying', kind: 'human' });
      const { row: future } = await addMember(db, team, {
        name: 'future',
        kind: 'human',
        lifecycle: 'until' as const,
        lifecycleUntil: Date.now() + 3600_000,
      });
      const swept = await sweepExpiredMembers(db);
      expect(swept.map((m) => m.name)).toEqual(['gone']);
      expect((await getMemberByName(db, team.id, 'gone'))!.left_at).not.toBeNull();
      expect((await getMemberByName(db, team.id, 'staying'))!.left_at).toBeNull();
      expect((await getMemberByName(db, team.id, 'future'))!.left_at).toBeNull();
      expect(gone.id).toBe(swept[0]!.id);
      expect(staying.id).toBeDefined();
      expect(future.id).toBeDefined();
    });

    it('never touches unexpiring members, and skips the already-departed', async () => {
      const { db, team } = await freshTeam();
      const { row: old } = await addMember(db, team, {
        name: 'old',
        kind: 'agent',
        lifecycle: 'until' as const,
        lifecycleUntil: Date.now() - 1000,
      });
      await leaveMember(db, old.id);
      expect(await sweepExpiredMembers(db)).toEqual([]);
      // An empty sweep is a no-op, not an error.
      expect(await sweepExpiredMembers(db)).toEqual([]);
    });
  });

  describe('account binding (ADR 698, spec §4.2)', () => {
    async function freshTeam() {
      const db = await openStore();
      return { db, team: await createTeam(db, { slug: 'acct-t' }) };
    }

    it('binds once: first bind sets it, same-account rebind is a no-op, lookup finds the member', async () => {
      const { db, team } = await freshTeam();
      const { row } = await addMember(db, team, { name: 'nick', kind: 'human' });
      await bindMemberAccount(db, row.id, 'acct_1');
      await bindMemberAccount(db, row.id, 'acct_1');
      expect((await getMemberByName(db, team.id, 'nick'))!.account_id).toBe('acct_1');
      expect((await memberByAccount(db, team.id, 'acct_1'))!.id).toBe(row.id);
      expect(await memberByAccount(db, team.id, 'acct_other')).toBeUndefined();
    });

    it('refuses to rebind a bound member to a different account', async () => {
      const { db, team } = await freshTeam();
      const { row } = await addMember(db, team, { name: 'nick', kind: 'human' });
      await bindMemberAccount(db, row.id, 'acct_1');
      await expect(bindMemberAccount(db, row.id, 'acct_2')).rejects.toThrow();
      expect((await getMemberByName(db, team.id, 'nick'))!.account_id).toBe('acct_1');
    });

    it('concurrent first binds of one member: exactly one account wins, the other is refused', async () => {
      const { db, team } = await freshTeam();
      const { row } = await addMember(db, team, { name: 'nick', kind: 'human' });
      const results = await Promise.allSettled([
        bindMemberAccount(db, row.id, 'acct_a'),
        bindMemberAccount(db, row.id, 'acct_b'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const winner = (await getMemberByName(db, team.id, 'nick'))!.account_id;
      expect(['acct_a', 'acct_b']).toContain(winner);
    });

    it('refuses to bind an account already held by another live member of the team', async () => {
      const { db, team } = await freshTeam();
      const { row: ann } = await addMember(db, team, { name: 'ann', kind: 'human' });
      const { row: bob } = await addMember(db, team, { name: 'bob', kind: 'human' });
      await bindMemberAccount(db, ann.id, 'acct_1');
      await expect(bindMemberAccount(db, bob.id, 'acct_1')).rejects.toThrow();
      expect((await getMemberByName(db, team.id, 'bob'))!.account_id).toBeNull();
      expect((await memberByAccount(db, team.id, 'acct_1'))!.id).toBe(ann.id);
    });

    it('concurrent binds of one account to two members: exactly one member wins', async () => {
      const { db, team } = await freshTeam();
      const { row: ann } = await addMember(db, team, { name: 'ann', kind: 'human' });
      const { row: bob } = await addMember(db, team, { name: 'bob', kind: 'human' });
      const results = await Promise.allSettled([
        bindMemberAccount(db, ann.id, 'acct_1'),
        bindMemberAccount(db, bob.id, 'acct_1'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const holder = (await memberByAccount(db, team.id, 'acct_1'))!;
      expect([ann.id, bob.id]).toContain(holder.id);
    });
  });
});
