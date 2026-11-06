import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  BROWSER_SESSION_ABSOLUTE_MS,
  BROWSER_SESSION_IDLE_MS,
  BROWSER_SESSION_PREFIX,
  createBrowserSession,
  listBrowserSessions,
  resolveBrowserSession,
  revokeBrowserSession,
  revokeBrowserSessionsForMember,
  sessionLabel,
} from './browserSessions.js';
import { addMember } from './members.js';
import type { MemberRow, TeamRow } from './rows.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;
withDrivers('browserSessions', (o) => {
  beforeEach(() => {
    openStore = o;
  });
  /** ADR 722 §3–4: the cookie's row — hashed secret, 14 d absolute, 3 d idle, per-session revoke. */
  let db: Driver;
  let team: TeamRow;
  let ada: MemberRow;
  beforeEach(async () => {
    db = await openStore();
    team = await createTeam(db, { slug: 'dawn' });
    ada = (await addMember(db, team, { name: 'ada', kind: 'human', role: '' })).row;
  });

  describe('browser sessions (ADR 722)', () => {
    it('creates a session whose secret is returned once and stored only as a hash', async () => {
      const t0 = 5_000_000;
      const s = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'Chrome' },
        t0,
      );
      expect(s.secret.startsWith(BROWSER_SESSION_PREFIX)).toBe(true);
      const row = await db.get<{ secret_hash: string; expires_at: number; label: string }>(
        'SELECT secret_hash, expires_at, label FROM browser_sessions WHERE id = ?',
        [s.id],
      );
      expect(row!.secret_hash).not.toContain(s.secret.slice(4));
      expect(row!.expires_at).toBe(t0 + BROWSER_SESSION_ABSOLUTE_MS);
      expect(row!.label).toBe('Chrome');
    });

    it('resolves a live secret, touches last_used_at, and refuses unknown / revoked / idle / expired', async () => {
      const t0 = 5_000_000;
      const s = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'Chrome' },
        t0,
      );
      const live = await resolveBrowserSession(db, team.id, s.secret, t0 + 10);
      expect(live.ok && live.session.member_id).toBe(ada.id);
      expect(live.ok && live.session.last_used_at).toBe(t0 + 10);
      expect(await resolveBrowserSession(db, team.id, 'mbs_nope', t0)).toEqual({
        ok: false,
        reason: 'unknown',
      });
      // Idle: more than 3 days since the last use.
      const idle = await resolveBrowserSession(
        db,
        team.id,
        s.secret,
        t0 + 10 + BROWSER_SESSION_IDLE_MS + 1,
      );
      expect(idle).toEqual({ ok: false, reason: 'idle' });
      // A refused resolve does not touch the row, so the next in-window use still works.
      expect((await resolveBrowserSession(db, team.id, s.secret, t0 + 20)).ok).toBe(true);
      await revokeBrowserSession(db, team.id, s.id, t0 + 30);
      expect(await resolveBrowserSession(db, team.id, s.secret, t0 + 40)).toEqual({
        ok: false,
        reason: 'revoked',
      });
    });

    it('refuses past the absolute expiry even when used steadily', async () => {
      const t0 = 5_000_000;
      const s = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'x' },
        t0,
      );
      let t = t0;
      while (t < t0 + BROWSER_SESSION_ABSOLUTE_MS) {
        t += BROWSER_SESSION_IDLE_MS - 1;
        if (t >= t0 + BROWSER_SESSION_ABSOLUTE_MS) break;
        expect((await resolveBrowserSession(db, team.id, s.secret, t)).ok).toBe(true);
      }
      expect(
        await resolveBrowserSession(db, team.id, s.secret, t0 + BROWSER_SESSION_ABSOLUTE_MS),
      ).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('lists a member’s sessions without secrets, newest first, revoked ones marked', async () => {
      const a = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'Chrome' },
        1,
      );
      const b = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'Safari' },
        2,
      );
      await revokeBrowserSession(db, team.id, a.id, 3);
      const list = await listBrowserSessions(db, team.id, ada.id);
      expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
      expect(list.map((s) => s.revoked_at)).toEqual([null, 3]);
      expect(JSON.stringify(list)).not.toContain('secret');
    });

    it('revokes every session of a member (credential rotate) and returns their ids', async () => {
      const bob = (await addMember(db, team, { name: 'bob', kind: 'human', role: '' })).row;
      const a = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'x' },
        1,
      );
      const b = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'y' },
        2,
      );
      const c = await createBrowserSession(
        db,
        { teamId: team.id, memberId: bob.id, label: 'z' },
        3,
      );
      expect((await revokeBrowserSessionsForMember(db, team.id, ada.id, 10)).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect((await resolveBrowserSession(db, team.id, c.secret, 11)).ok).toBe(true);
      // Already revoked rows are not revoked again.
      expect(await revokeBrowserSessionsForMember(db, team.id, ada.id, 12)).toEqual([]);
    });

    it('revoking a session is scoped to its team', async () => {
      const other = await createTeam(db, { slug: 'dusk' });
      const s = await createBrowserSession(
        db,
        { teamId: team.id, memberId: ada.id, label: 'x' },
        1,
      );
      expect(await revokeBrowserSession(db, other.id, s.id, 2)).toBe(false);
      expect((await resolveBrowserSession(db, team.id, s.secret, 3)).ok).toBe(true);
    });

    it('labels by user-agent family, never the full string', () => {
      expect(
        sessionLabel(
          'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        ),
      ).toBe('Chrome');
      expect(
        sessionLabel(
          'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        ),
      ).toBe('Safari');
      expect(sessionLabel('Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/131.0')).toBe('Firefox');
      expect(sessionLabel('Mozilla/5.0 (Windows) Edg/130.0')).toBe('Edge');
      expect(sessionLabel('curl/8.0 secret-token-in-ua')).toBe('browser');
      expect(sessionLabel(undefined)).toBe('browser');
    });
  });
});
