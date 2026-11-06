import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import { consumeSigninState, SIGNIN_STATE_TTL_MS, startSigninState } from './signinStates.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;
withDrivers('signinStates', (o) => {
  beforeEach(() => {
    openStore = o;
  });
  /** ADR 722 §1–2: one-time, ten-minute, hashed; consumed once whatever the outcome. */
  let db: Driver;
  let teamId: string;
  beforeEach(async () => {
    db = await openStore();
    teamId = (await createTeam(db, { slug: 'dawn' })).id;
  });

  describe('signin states (ADR 722)', () => {
    it('starts a signin state and hands back a random state the row holds only as a hash', async () => {
      const t0 = 1_000_000;
      const s = await startSigninState(db, { teamId, mode: 'signin' }, t0);
      expect(s.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const row = await db.get<{ state_hash: string; expires_at: number; mode: string }>(
        'SELECT state_hash, expires_at, mode FROM signin_states WHERE id = ?',
        [s.id],
      );
      expect(row!.state_hash).not.toContain(s.state);
      expect(row!.expires_at).toBe(t0 + SIGNIN_STATE_TTL_MS);
      expect(row!.mode).toBe('signin');
    });

    it('consumes once: the second consume of the same state is spent, a wrong state is unknown', async () => {
      const t0 = 1_000_000;
      const s = await startSigninState(db, { teamId, mode: 'signin' }, t0);
      const first = await consumeSigninState(db, teamId, s.state, t0 + 1);
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.record.mode).toBe('signin');
      const again = await consumeSigninState(db, teamId, s.state, t0 + 2);
      expect(again).toEqual({ ok: false, reason: 'spent' });
      expect(await consumeSigninState(db, teamId, 'nope', t0 + 2)).toEqual({
        ok: false,
        reason: 'unknown',
      });
    });

    it('refuses an expired state and spends it', async () => {
      const t0 = 1_000_000;
      const s = await startSigninState(db, { teamId, mode: 'signin' }, t0);
      const late = await consumeSigninState(db, teamId, s.state, t0 + SIGNIN_STATE_TTL_MS + 1);
      expect(late).toEqual({ ok: false, reason: 'expired' });
      expect(await consumeSigninState(db, teamId, s.state, t0 + 1)).toEqual({
        ok: false,
        reason: 'spent',
      });
    });

    it('carries the pinned member for link and the invite id + name for invite', async () => {
      const team = (await db.get<{ id: string; slug: string }>('SELECT * FROM teams WHERE id = ?', [
        teamId,
      ]))!;
      const ada = (await addMember(db, team as never, { name: 'ada', kind: 'human', role: '' }))
        .row;
      const link = await startSigninState(db, { teamId, mode: 'link', memberId: ada.id });
      const got = await consumeSigninState(db, teamId, link.state);
      expect(got.ok && got.record.member_id).toBe(ada.id);
      const inv = await startSigninState(db, {
        teamId,
        mode: 'invite',
        inviteId: 'inv_1',
        name: 'newcomer',
      });
      const got2 = await consumeSigninState(db, teamId, inv.state);
      expect(got2.ok && [got2.record.invite_id, got2.record.name]).toEqual(['inv_1', 'newcomer']);
    });

    it('a state belongs to its team: consuming it under another team is unknown', async () => {
      const other = (await createTeam(db, { slug: 'dusk' })).id;
      const s = await startSigninState(db, { teamId, mode: 'signin' });
      expect(await consumeSigninState(db, other, s.state)).toEqual({
        ok: false,
        reason: 'unknown',
      });
      expect((await consumeSigninState(db, teamId, s.state)).ok).toBe(true);
    });
  });
});
