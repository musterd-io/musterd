import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { insertProvision } from '../store/hostProvisions.js';
import { getMemberByName } from '../store/members.js';
import { requireTeam } from '../store/teams.js';
import { __resetOAuthBucketsForTest } from './oauth.js';

withDrivers('move-provision-host-key-http', (_o, kind) => {
  /**
   * ADR 762: a host key reaches a seat its creator does not sponsor only through a claimed `move`
   * row pinned to the key's own label and authored by the key's creator. Mint rows keep the
   * sponsor check; another label, another seat, or no claim is refused as before.
   */
  let server: RunningServer;
  let base: string;
  let nick: string;

  async function post(path: string, body: unknown, bearer?: string) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  async function hostKey(label: string): Promise<string> {
    const r = await post(
      '/teams/mv-t/agent-bootstrap-credentials',
      { use: 'host', target: label },
      nick,
    );
    expect(r.status).toBe(201);
    return r.json.agent_key as string;
  }

  /** An unsponsored agent with a move row pinned to `host`, authored by nick. */
  async function movedTo(seat: string, host: string, rowKind: 'move' | 'mint' = 'move') {
    expect((await post('/teams/mv-t/members', { name: seat, kind: 'agent' }, nick)).status).toBe(
      201,
    );
    const team = await requireTeam(server.store, 'mv-t');
    const agent = (await getMemberByName(server.store, team.id, seat))!;
    expect(agent.sponsored_by).toBeNull();
    const nickRow = (await getMemberByName(server.store, team.id, 'nick'))!;
    await insertProvision(
      server.store,
      team.id,
      agent.id,
      nickRow.id,
      Date.now(),
      null,
      host,
      rowKind,
      rowKind === 'move' ? JSON.stringify({ harness: 'claude-code', policy: null }) : null,
    );
  }

  const mintSeatCredential = (seat: string, key: string) =>
    post('/teams/mv-t/agent-bootstrap-credentials', { use: 'claim_seat', target: seat }, key);

  beforeEach(async () => {
    __resetOAuthBucketsForTest();
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const r = await post('/teams', { slug: 'mv-t', creator: { name: 'nick', kind: 'human' } });
    nick = r.json.human_credential;
  });

  afterEach(async () => {
    await server.close();
  });

  describe('a host key finishing a move (ADR 762)', () => {
    it('claims the pinned move row and mints the moved seat its credential', async () => {
      await movedTo('ryder', 'box');
      const key = await hostKey('box');
      const claim = await post(
        '/teams/mv-t/host/provisions',
        { host: 'box', kinds: ['move'] },
        key,
      );
      expect(claim.status).toBe(200);
      expect(claim.json.provisions.map((p: any) => p.agent)).toEqual(['ryder']);
      const minted = await mintSeatCredential('ryder', key);
      expect(minted.status).toBe(201);
    });

    it('ADR 765: finishing a move reissues the seat credential, so the new claim gets one', async () => {
      await movedTo('ryder', 'box');
      const team = await requireTeam(server.store, 'mv-t');
      const ryder = (await getMemberByName(server.store, team.id, 'ryder'))!;
      await server.store.run('UPDATE members SET credential_hash = ? WHERE id = ?', [
        'old-machine',
        ryder.id,
      ]);
      const key = await hostKey('box');
      await post('/teams/mv-t/host/provisions', { host: 'box', kinds: ['move'] }, key);
      const minted = await mintSeatCredential('ryder', key);
      expect(minted.status).toBe(201);
      // Cleared, so the new machine's first claim mints the seat credential (agentAuthorityFor).
      expect((await getMemberByName(server.store, team.id, 'ryder'))!.credential_hash).toBeNull();
    });

    it('a sponsored mint never reissues: only a claimed move row does', async () => {
      await movedTo('ryder', 'box', 'mint');
      const team = await requireTeam(server.store, 'mv-t');
      const ryder = (await getMemberByName(server.store, team.id, 'ryder'))!;
      await server.store.run('UPDATE members SET credential_hash = ? WHERE id = ?', [
        'kept',
        ryder.id,
      ]);
      // nick's admin credential mints the claim_seat directly (not via a host key): no reissue.
      await mintSeatCredential('ryder', nick);
      expect((await getMemberByName(server.store, team.id, 'ryder'))!.credential_hash).toBe('kept');
    });

    it('refuses before the row is claimed', async () => {
      await movedTo('ryder', 'box');
      const key = await hostKey('box');
      expect((await mintSeatCredential('ryder', key)).status).toBe(403);
    });

    it('refuses a key for another label, and leaves the row to its own host', async () => {
      await movedTo('ryder', 'box');
      const other = await hostKey('elsewhere');
      const claim = await post(
        '/teams/mv-t/host/provisions',
        { host: 'elsewhere', kinds: ['move'] },
        other,
      );
      expect(claim.json.provisions).toEqual([]);
      expect((await mintSeatCredential('ryder', other)).status).toBe(403);
    });

    it('refuses a seat the claimed row does not name', async () => {
      await movedTo('ryder', 'box');
      expect(
        (await post('/teams/mv-t/members', { name: 'sloane', kind: 'agent' }, nick)).status,
      ).toBe(201);
      const key = await hostKey('box');
      await post('/teams/mv-t/host/provisions', { host: 'box', kinds: ['move'] }, key);
      expect((await mintSeatCredential('sloane', key)).status).toBe(403);
    });

    it('never widens a mint row: an unsponsored seat behind one stays refused', async () => {
      await movedTo('ryder', 'box', 'mint');
      const key = await hostKey('box');
      await post('/teams/mv-t/host/provisions', { host: 'box', kinds: ['mint'] }, key);
      expect((await mintSeatCredential('ryder', key)).status).toBe(403);
    });
  });
});
