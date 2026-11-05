import { describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import { attach, listReclaimableMemberIds, release } from './presence.js';
import { enrollResidency } from './residency.js';
import { createTeam } from './teams.js';
import {
  EXIT_SETTLE_MS,
  releaseExitedSessionHolds,
  releaseLateWakeHolds,
  releaseWakeHold,
} from './wakeHold.js';

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

    it('releaseLateWakeHolds: a leaseless hold parked after a recently reported lease ends; others stand', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const bo = (await addMember(db, team, { name: 'Bo', kind: 'agent' })).row;
      const now = Date.now();
      await db.run(
        `INSERT INTO wake_leases (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at, edge, spawned_at)
         VALUES ('L1', ?, ?, 'A1', NULL, 'h', 'batched', 'reported', ?, ?, NULL, ?)`,
        [team.id, ada.id, now - 60_000, now + 60_000, now - 50_000],
      );
      // The SessionEnd hook's row: parked after the report, stamped with the wake's lease (the hook
      // runs with MUSTERD_WAKE_LEASE set) — smoke pair 3 of the rider 7 re-run.
      const late = await attach(db, ada.id, 'cli', 'c2', { wake_lease: 'L1' });
      await release(db, late.id, 45_000);
      // And one with no lease at all (an interrupt-probe style claim after the report).
      const bare = await attach(db, ada.id, 'cli', 'c5', {});
      await release(db, bare.id, 45_000);
      // Bo has no reported lease: its hold stands.
      const other = await attach(db, bo.id, 'cli', 'c3', {});
      await release(db, other.id, 45_000);
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set([ada.id, bo.id]));
      expect(await releaseLateWakeHolds(db, team.id, now)).toBe(2);
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(new Set([bo.id]));
      // Outside the window the lease no longer speaks for new holds.
      const again = await attach(db, ada.id, 'cli', 'c4', {});
      await release(db, again.id, 45_000);
      expect(await releaseLateWakeHolds(db, team.id, now, 30_000)).toBe(0);
    });

    it('releaseLateWakeHolds never touches a live session, with or without a recent reported lease', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const now = Date.now();
      await db.run(
        `INSERT INTO wake_leases (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at, edge, spawned_at)
         VALUES ('L1', ?, ?, 'A1', NULL, 'h', 'batched', 'reported', ?, ?, NULL, ?)`,
        [team.id, ada.id, now - 60_000, now + 60_000, now - 50_000],
      );
      // A live session stamped with the reported lease (the next wake's own MCP session, say).
      await attach(db, ada.id, 'claude-code', 'c1', { wake_lease: 'L1' });
      expect(await releaseLateWakeHolds(db, team.id, now)).toBe(0);
      const row = await db.get<{ held_until: number | null; conn_id: string | null }>(
        'SELECT held_until, conn_id FROM presence WHERE member_id = ?',
        [ada.id],
      );
      expect(row).toEqual({ held_until: null, conn_id: 'c1' });
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

  describe('releaseExitedSessionHolds (ADR 809)', () => {
    /** The SessionEnd hook's clean goodbye, as `POST /residency/session {event:'end'}` audits it. */
    async function sessionEnded(db: Driver, teamId: string, seat: string, ts: number) {
      await db.run(
        `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
         VALUES (?, ?, ?, NULL, 'residency.session_ended', ?, 'allow', NULL, ?)`,
        [`a-${seat}-${ts}`, teamId, ts, seat, ts],
      );
    }
    /** A parked row (ADR 010 hold) last seen at `seenAt`, attached at `createdAt` (default: a
     *  minute before it parked — a session that ran a while). */
    async function parked(
      db: Driver,
      memberId: string,
      conn: string,
      seenAt: number,
      createdAt = seenAt - 60_000,
    ) {
      const row = await attach(db, memberId, 'claude-code', conn, {});
      await release(db, row.id, 45_000);
      await db.run(
        'UPDATE presence SET last_seen_at = ?, held_until = ?, created_at = ? WHERE id = ?',
        [seenAt, seenAt + 45_000, createdAt, row.id],
      );
      return row;
    }
    async function enroll(
      db: Driver,
      teamId: string,
      memberId: string,
      policy?: Record<string, unknown>,
    ) {
      await enrollResidency(db, teamId, {
        member_id: memberId,
        harness: 'claude-code',
        host: 'h',
        grant_id: 'g1',
        authorized_by: 'nick',
        ...(policy !== undefined ? { policy } : {}),
      });
    }

    it("releases an act-lane seat's rows parked around its harness exit, and nothing else", async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      const bo = (await addMember(db, team, { name: 'Bo', kind: 'agent' })).row;
      const cy = (await addMember(db, team, { name: 'Cy', kind: 'agent' })).row;
      await enroll(db, team.id, ada.id, { lane: 'act' });
      await enroll(db, team.id, bo.id, { lane: 'batched' });
      // Cy is not enrolled at all.
      const now = Date.now();
      const exitAt = now - 10_000;
      await sessionEnded(db, team.id, 'Ada', exitAt);
      await sessionEnded(db, team.id, 'Bo', exitAt);
      await sessionEnded(db, team.id, 'Cy', exitAt);
      // Ada: the MCP session closes a few seconds before the hook posts; the hook's own CLI claim
      // parks a few seconds after it; a later session of her own parked past the settle window.
      await parked(db, ada.id, 'mcp', exitAt - 3_000);
      // The hook's claim is the session that posts the exit: created at or before the row's ts.
      await parked(db, ada.id, 'hook', exitAt + 4_000, exitAt);
      const later = await parked(db, ada.id, 'later', exitAt + EXIT_SETTLE_MS + 1_000);
      // A session the seat's person starts AFTER the exit — by one millisecond — and parks inside
      // the settle window is not the exiting run (big-body's acceptance reads, 2026-11-05).
      const fresh = await parked(db, ada.id, 'fresh', exitAt + 30_000, exitAt + 1);
      await parked(db, bo.id, 'bo', exitAt + 1_000);
      await parked(db, cy.id, 'cy', exitAt + 1_000);
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(
        new Set([ada.id, bo.id, cy.id]),
      );

      expect(await releaseExitedSessionHolds(db, team.id, now)).toBe(2);
      // Ada's later and fresh sessions still hold; Bo (batched lane) and Cy (unenrolled) keep theirs.
      expect(await listReclaimableMemberIds(db, team.id, now)).toEqual(
        new Set([ada.id, bo.id, cy.id]),
      );
      const rows = await db.all<{ id: string; held_until: number }>(
        'SELECT id, held_until FROM presence WHERE member_id = ? ORDER BY last_seen_at ASC',
        [ada.id],
      );
      expect(rows.map((r) => r.held_until > now)).toEqual([false, false, true, true]);
      expect(rows.slice(2).map((r) => r.id)).toEqual([fresh.id, later.id]);
      // Idempotent.
      expect(await releaseExitedSessionHolds(db, team.id, now)).toBe(0);
    });

    it('runs inside the per-poll sweep, never touches a live session, and forgets an old exit', async () => {
      const db = await openStore();
      const team = await createTeam(db, { slug: 'revive' });
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
      await enroll(db, team.id, ada.id, { lane: 'act' });
      const now = Date.now();
      await sessionEnded(db, team.id, 'Ada', now - 5_000);
      // The seat's next session is already live: the sweep must not park or release it.
      await attach(db, ada.id, 'claude-code', 'live', {});
      expect(await releaseLateWakeHolds(db, team.id, now)).toBe(0);
      expect(
        await db.get<{ held_until: number | null; conn_id: string | null }>(
          'SELECT held_until, conn_id FROM presence WHERE member_id = ?',
          [ada.id],
        ),
      ).toEqual({ held_until: null, conn_id: 'live' });
      // A hold parked around the exit goes through the per-poll sweep too.
      await parked(db, ada.id, 'hook', now - 2_000, now - 5_100);
      expect(await releaseLateWakeHolds(db, team.id, now)).toBe(1);
      // An exit older than the window speaks for nothing.
      await parked(db, ada.id, 'again', now - 1_000, now - 5_100);
      expect(await releaseLateWakeHolds(db, team.id, now, 3_000)).toBe(0);
    });
  });
});
