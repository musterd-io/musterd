import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDb } from '../db/open.js';
import { withDrivers } from '../db/testing.js';
import { MusterdError } from '../errors.js';
import { addMember, authMember } from './members.js';
import {
  burnUnexchangedCodes,
  issueCode,
  mintTokenPair,
  pkceChallenge,
  redeemCode,
  registerClient,
  revokeAllForMember,
  revokeToken,
  rotateRefresh,
  verifyAccess,
} from './oauth.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('oauth', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function freshHuman() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    const { row } = await addMember(db, team, { name: 'Nick', kind: 'human', role: '' });
    const { client_id } = await registerClient(db, {
      teamId: team.id,
      clientName: 'Claude',
      redirectUris: ['https://app.example/cb'],
    });
    return { db, team, member: row, client_id };
  }

  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = pkceChallenge(VERIFIER);

  async function codeFor(db: ReturnType<typeof openDb>, f: ReturnType<typeof freshHuman>) {
    return await issueCode(db, {
      teamId: f.team.id,
      memberId: f.member.id,
      clientId: f.client_id,
      redirectUri: 'https://app.example/cb',
      codeChallenge: CHALLENGE,
    });
  }

  describe('oauth store (ADR 446)', async () => {
    it('code redeem → mint → bearer authenticates like mscr_, no lease', async () => {
      const f = await freshHuman();
      const { code } = await codeFor(f.db, f);
      const { memberId } = await redeemCode(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        code,
        redirectUri: 'https://app.example/cb',
        verifier: VERIFIER,
      });
      expect(memberId).toBe(f.member.id);
      const pair = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId,
        clientId: f.client_id,
      });
      expect(pair.access_token.startsWith('msat_')).toBe(true);
      expect(pair.refresh_token.startsWith('msrt_')).toBe(true);
      // No lease presented — and none required.
      const auth = await authMember(f.db, 'dawn', pair.access_token);
      expect(auth.member.name).toBe('Nick');
      expect((await authMember(f.db, 'dawn', pair.access_token, 'Nick')).member.name).toBe('Nick');
      await expect(authMember(f.db, 'dawn', pair.access_token, 'Ada')).rejects.toThrow(
        MusterdError,
      );
    });

    it('code is single-use — a replay is refused', async () => {
      const f = await freshHuman();
      const { code } = await codeFor(f.db, f);
      const input = {
        teamId: f.team.id,
        clientId: f.client_id,
        code,
        redirectUri: 'https://app.example/cb',
        verifier: VERIFIER,
      };
      await redeemCode(f.db, input);
      await expect(redeemCode(f.db, input)).rejects.toThrow(/replayed/);
    });

    it('PKCE downgrade, redirect mismatch, and expiry all fail closed', async () => {
      const f = await freshHuman();
      const { code } = await codeFor(f.db, f);
      const base = {
        teamId: f.team.id,
        clientId: f.client_id,
        code,
        redirectUri: 'https://app.example/cb' as string,
        verifier: VERIFIER,
      };
      await expect(redeemCode(f.db, { ...base, verifier: 'wrong' })).rejects.toThrow(/PKCE/);
      await expect(
        redeemCode(f.db, { ...base, redirectUri: 'https://evil.example/cb' }),
      ).rejects.toThrow(/redirect/);
      await expect(redeemCode(f.db, base, Date.now() + 91_000)).rejects.toThrow(/expired/);
      // Cross-team bearer is refused.
      const pair = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: f.member.id,
        clientId: f.client_id,
      });
      await expect(authMember(f.db, 'dawn2', pair.access_token)).rejects.toThrow();
    });

    it('refresh rotates on the same chain — reuse revokes the chain', async () => {
      const f = await freshHuman();
      const first = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: f.member.id,
        clientId: f.client_id,
      });
      const second = await rotateRefresh(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        refreshToken: first.refresh_token,
      });
      expect(second.access_token).not.toBe(first.access_token);
      // Old access token still valid until its own hour; burned refresh re-presented = theft signal.
      expect((await verifyAccess(f.db, f.team.id, first.access_token)).name).toBe('Nick');
      await expect(
        rotateRefresh(f.db, {
          teamId: f.team.id,
          clientId: f.client_id,
          refreshToken: first.refresh_token,
        }),
      ).rejects.toThrow(/revoked/);
      // The whole chain is dead — including the just-minted pair.
      await expect(verifyAccess(f.db, f.team.id, second.access_token)).rejects.toThrow();
      await expect(
        rotateRefresh(f.db, {
          teamId: f.team.id,
          clientId: f.client_id,
          refreshToken: second.refresh_token,
        }),
      ).rejects.toThrow(/revoked/);
    });

    it('revoke drops one token; revoke-all drops the seat', async () => {
      const f = await freshHuman();
      const pair = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: f.member.id,
        clientId: f.client_id,
      });
      expect(await revokeToken(f.db, f.team.id, pair.access_token)).toBe(true);
      await expect(verifyAccess(f.db, f.team.id, pair.access_token)).rejects.toThrow();
      const pair2 = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: f.member.id,
        clientId: f.client_id,
      });
      expect(await revokeAllForMember(f.db, f.team.id, f.member.id)).toBeGreaterThan(0);
      await expect(verifyAccess(f.db, f.team.id, pair2.access_token)).rejects.toThrow();
      await expect(
        rotateRefresh(f.db, {
          teamId: f.team.id,
          clientId: f.client_id,
          refreshToken: pair2.refresh_token,
        }),
      ).rejects.toThrow();
    });

    it('bearer for a departed seat is refused', async () => {
      const f = await freshHuman();
      const pair = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: f.member.id,
        clientId: f.client_id,
      });
      await f.db.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), f.member.id]);
      await expect(verifyAccess(f.db, f.team.id, pair.access_token)).rejects.toThrow(/gone/);
    });
  });

  describe('agent chains and member standing at the token endpoint (ADR 452 §2–4)', async () => {
    const HOUR = 3600_000;

    async function mint(f: ReturnType<typeof freshHuman>, memberId = f.member.id) {
      return await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId,
        clientId: f.client_id,
      });
    }

    it('verifyAccess admits an agent-bound chain (§3)', async () => {
      const f = await freshHuman();
      const { row: agent } = await addMember(f.db, f.team, {
        name: 'scout',
        kind: 'agent',
      });
      const pair = await mint(f, agent.id);
      expect((await verifyAccess(f.db, f.team.id, pair.access_token)).name).toBe('scout');
    });

    it('burnUnexchangedCodes refuses a code issued before a supersede (§2.3)', async () => {
      const f = await freshHuman();
      const { code } = await codeFor(f.db, f);
      expect(await burnUnexchangedCodes(f.db, f.team.id, f.member.id)).toBe(1);
      await expect(
        redeemCode(f.db, {
          teamId: f.team.id,
          clientId: f.client_id,
          code,
          redirectUri: 'https://app.example/cb',
          verifier: VERIFIER,
        }),
      ).rejects.toThrow(/replayed/);
      expect(await burnUnexchangedCodes(f.db, f.team.id, f.member.id)).toBe(0);
    });

    it("caps the pair at the member's lifecycle_until (§4 / ADR 449 §1)", async () => {
      const f = await freshHuman();
      const until = Date.now() + 10 * 60_000;
      await f.db.run("UPDATE members SET lifecycle = 'until', lifecycle_until = ? WHERE id = ?", [
        until,
        f.member.id,
      ]);
      const pair = await mint(f);
      expect(pair.expires_in).toBeLessThanOrEqual(600);
      expect(pair.expires_in).toBeGreaterThan(590);
      const refresh = (await f.db.get(
        "SELECT expires_at FROM oauth_tokens WHERE kind = 'refresh'",
      )) as { expires_at: number };
      expect(refresh.expires_at).toBeLessThanOrEqual(until);
    });

    it('an unexpiring member keeps the full TTLs', async () => {
      const f = await freshHuman();
      expect((await mint(f)).expires_in).toBe(3600);
    });

    it('refresh for a member whose standing ended is refused AND revokes the chain', async () => {
      for (const end of ['disabled', 'expired', 'left'] as const) {
        const f = await freshHuman();
        const pair = await mint(f);
        if (end === 'disabled')
          await f.db.run("UPDATE members SET account_status = 'disabled' WHERE id = ?", [
            f.member.id,
          ]);
        if (end === 'expired')
          await f.db.run(
            "UPDATE members SET lifecycle = 'until', lifecycle_until = ? WHERE id = ?",
            [Date.now() - HOUR, f.member.id],
          );
        if (end === 'left')
          await f.db.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), f.member.id]);
        await expect(
          rotateRefresh(f.db, {
            teamId: f.team.id,
            clientId: f.client_id,
            refreshToken: pair.refresh_token,
          }),
        ).rejects.toThrow(MusterdError);
        const live = (await f.db.get(
          'SELECT COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IS NULL',
        )) as { n: number };
        expect(live.n, end).toBe(0);
      }
    });
  });

  describe('the connector bounds the chain (ADR 456 §3)', async () => {
    async function agentConnectedBy() {
      const f = await freshHuman();
      const { row: agent } = await addMember(f.db, f.team, {
        name: 'scout',
        kind: 'agent',
      });
      const { row: mate } = await addMember(f.db, f.team, {
        name: 'mate',
        kind: 'human',
      });
      const { code } = await issueCode(f.db, {
        teamId: f.team.id,
        memberId: agent.id,
        clientId: f.client_id,
        redirectUri: 'https://app.example/cb',
        codeChallenge: CHALLENGE,
        connectedBy: mate.id,
      });
      const redeemed = await redeemCode(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        code,
        redirectUri: 'https://app.example/cb',
        verifier: VERIFIER,
      });
      const pair = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: redeemed.memberId,
        clientId: f.client_id,
        connectedBy: redeemed.connectedBy,
      });
      return { ...f, agent, mate, redeemed, pair };
    }

    it('the code carries connected_by to the chain', async () => {
      const f = await agentConnectedBy();
      expect(f.redeemed.connectedBy).toBe(f.mate.id);
      const rows = (
        await f.db.all<Record<string, string>>('SELECT DISTINCT connected_by FROM oauth_tokens')
      ).map((r) => Object.values(r)[0]!);
      expect(rows).toEqual([f.mate.id]);
      expect((await verifyAccess(f.db, f.team.id, f.pair.access_token)).name).toBe('scout');
    });

    it('the chain dies at use when its connector leaves, though the agent is fine', async () => {
      const f = await agentConnectedBy();
      await f.db.run('UPDATE members SET left_at = ? WHERE id = ?', [Date.now(), f.mate.id]);
      await expect(verifyAccess(f.db, f.team.id, f.pair.access_token)).rejects.toThrow(/connected/);
    });

    it('refresh keeps connected_by, and is refused (chain revoked) once the connector is disabled', async () => {
      const f = await agentConnectedBy();
      const next = await rotateRefresh(f.db, {
        teamId: f.team.id,
        clientId: f.client_id,
        refreshToken: f.pair.refresh_token,
      });
      const rows = (
        await f.db.all<Record<string, string>>('SELECT DISTINCT connected_by FROM oauth_tokens')
      ).map((r) => Object.values(r)[0]!);
      expect(rows).toEqual([f.mate.id]);
      await f.db.run("UPDATE members SET account_status = 'disabled' WHERE id = ?", [f.mate.id]);
      await expect(
        rotateRefresh(f.db, {
          teamId: f.team.id,
          clientId: f.client_id,
          refreshToken: next.refresh_token,
        }),
      ).rejects.toThrow(MusterdError);
      const live = (await f.db.get(
        'SELECT COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IS NULL',
      )) as { n: number };
      expect(live.n).toBe(0);
    });

    it('a chain with no connector (a human signing themselves in) is unaffected', async () => {
      const f = await freshHuman();
      const pair = await mintTokenPair(f.db, {
        teamId: f.team.id,
        memberId: f.member.id,
        clientId: f.client_id,
      });
      expect((await verifyAccess(f.db, f.team.id, pair.access_token)).name).toBe('Nick');
    });
  });
});
