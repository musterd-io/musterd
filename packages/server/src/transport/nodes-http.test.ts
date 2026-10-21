import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { applyFoldedEnrollment, bindHostToNode } from '../store/residency.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

withDrivers('nodes-http', (_o, kind) => {
  /**
   * The node enrollment routes (ADR 328), increment 3a of the ADR 325 federation build.
   *
   * Two properties these tests exist to hold. `join` is authenticated by the invite code and nothing
   * else — that IS the ceremony (§2), so it must work unauthenticated and still refuse a spent code.
   * And an `msnode_` admits its bearer to the sync surface only (§3): a machine being *admitted* and
   * a seat being *authorized* are independent axes, and collapsing them would make one laptop's
   * compromise a licence to mint teammates.
   */

  let server: RunningServer;
  let base: string;
  let nickCredential: string;
  let adaKey: string;
  let adaAuth: AgentHttpAuth;

  type Auth = string | AgentHttpAuth;

  function headers(auth?: Auth): Record<string, string> {
    if (!auth) return {};
    if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
    return {
      authorization: `Bearer ${auth.key}`,
      'x-musterd-seat': auth.seat,
      'x-musterd-session-lease': auth.sessionLease,
    };
  }

  async function request(method: string, path: string, body?: unknown, auth?: Auth) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers(auth) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }

  /** An admin-minted invite, the way an operator gets one. */
  async function invite(label = 'joiner laptop'): Promise<string> {
    const res = await request('POST', '/teams/bravo/nodes/invite', { label }, nickCredential);
    expect(res.status).toBe(200);
    return res.json.invite;
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;

    const created = await request('POST', '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickCredential = created.json.human_credential;
    adaKey = created.json.agent_key;
    await request('POST', '/teams/bravo/members', { name: 'ada', kind: 'agent' }, nickCredential);
    adaAuth = await claimAgentHttp(base, 'bravo', adaKey, nickCredential, 'ada');
  });

  afterEach(async () => {
    await server.close();
  });

  describe('node enrollment routes (ADR 328)', () => {
    it('mints an invite for an admin, and a joiner trades it for a credential', async () => {
      const code = await invite();
      expect(code).toMatch(/^msinv_/);

      const joined = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'joiner laptop',
      });

      expect(joined.status).toBe(200);
      expect(joined.json.node_credential).toMatch(/^msnode_/);
      expect(joined.json.node_id).toBe('node-remote');
      expect(joined.json.team).toBe('bravo');
    });

    it('join needs no seat credential — the code is the whole ceremony (§2)', async () => {
      const code = await invite();
      // No authorization header at all.
      const joined = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });
      expect(joined.status).toBe(200);
    });

    it('two daemons racing one invite: exactly one is admitted', async () => {
      const code = await invite();

      const [a, b] = await Promise.all([
        await request('POST', '/teams/bravo/nodes/join', { code, node_id: 'node-a', label: 'a' }),
        await request('POST', '/teams/bravo/nodes/join', { code, node_id: 'node-b', label: 'b' }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      // And only the winner got a row.
      const rows = await server.store.get(
        "SELECT COUNT(*) AS n FROM nodes WHERE id IN ('node-a','node-b') AND credential_hash IS NOT NULL",
      );
      expect(rows?.n).toBe(1);
    });

    it('refuses a spent code, an unknown code, and a node id already bound', async () => {
      const first = await invite();
      await request('POST', '/teams/bravo/nodes/join', {
        code: first,
        node_id: 'node-remote',
        label: 'laptop',
      });

      expect(
        (
          await request('POST', '/teams/bravo/nodes/join', {
            code: first,
            node_id: 'node-other',
            label: 'l',
          })
        ).status,
      ).toBe(409);

      expect(
        (
          await request('POST', '/teams/bravo/nodes/join', {
            code: 'msinv_nope',
            node_id: 'node-other',
            label: 'l',
          })
        ).status,
      ).toBe(409);

      // A fresh code cannot re-bind an id that already carries a credential (the ADR 331 refusal).
      const second = await invite();
      expect(
        (
          await request('POST', '/teams/bravo/nodes/join', {
            code: second,
            node_id: 'node-remote',
            label: 'l',
          })
        ).status,
      ).toBe(409);
    });

    it('a refused bind does not burn the invite — the code survives to be retried', async () => {
      // Take an id, then try to enroll a SECOND machine onto it with a fresh code. The bind is
      // refused, and the operator's still-unspent code must survive: consume-and-bind is one
      // transaction, so a rolled-back bind rolls the consumption back with it. Without that, a
      // fat-fingered node id would silently cost the operator an invite and they would have to mint
      // another to find out why.
      const first = await invite();
      await request('POST', '/teams/bravo/nodes/join', {
        code: first,
        node_id: 'node-taken',
        label: 'first',
      });

      const code = await invite();
      expect(
        (
          await request('POST', '/teams/bravo/nodes/join', {
            code,
            node_id: 'node-taken',
            label: 'second',
          })
        ).status,
      ).toBe(409);

      // Same code, a free id: it still works.
      const retry = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-free',
        label: 'second',
      });
      expect(retry.status).toBe(200);
      expect(retry.json.node_id).toBe('node-free');
    });

    it('does not answer whether an unknown team exists — same 409 as every refusal', async () => {
      // The route is unauthenticated by design, so a 404 for an unknown slug is a free team-slug
      // oracle on a public bind (ryder, 2026-08-27). Both shapes must be indistinguishable.
      const unknown = await request('POST', '/teams/no-such-team/nodes/join', {
        code: 'msinv_x',
        node_id: 'node-x',
        label: 'l',
      });
      const known = await request('POST', '/teams/bravo/nodes/join', {
        code: 'msinv_x',
        node_id: 'node-x',
        label: 'l',
      });
      expect(unknown.status).toBe(409);
      expect(known.status).toBe(409);
      expect(unknown.json).toEqual(known.json);
    });

    it('records WHICH invite admitted a node, so the audit chain joins', async () => {
      const code = await invite();
      await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });

      const team = (await getTeamBySlug(server.store, 'bravo'))!;
      const enrolledBy = (await server.store.get('SELECT enrolled_by FROM nodes WHERE id = ?', [
        'node-remote',
      ]))!.enrolled_by;
      const inviteId = (await server.store.get('SELECT id FROM node_invites WHERE team_id = ?', [
        team.id,
      ]))!.id;
      // Not the literal string 'invite' — the row id, so node.invited → node.enrolled is joinable.
      expect(enrolledBy).toBe(`invite:${inviteId}`);
    });

    it("refuses a joiner presenting the hub's own node id", async () => {
      // Make the hub mint its own local row the way a live daemon does — by writing to its log.
      const team = (await getTeamBySlug(server.store, 'bravo'))!;
      const nick = await server.store.get('SELECT id FROM members WHERE team_id = ? AND name = ?', [
        team.id,
        'nick',
      ])!;
      await insertMessage(
        server.store,
        team.id,
        nick.id,
        null,
        makeEnvelope({
          id: 'm-1',
          team: 'bravo',
          from: 'nick',
          to: { kind: 'team' as const },
          act: 'message',
          body: 'hi',
          ts: 1000,
          meta: null,
        }),
      );
      const ours = (await server.store.get('SELECT node_id FROM local_node WHERE team_id = ?', [
        team.id,
      ]))!.node_id;

      const code = await invite();
      const res = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: ours,
        label: 'impostor',
      });
      expect(res.status).toBe(409);
    });

    it('an msnode_ cannot act as a seat (§3) — admitted is not authorized', async () => {
      const code = await invite();
      const { json } = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });
      const nodeCredential = json.node_credential;

      // It is not a seat credential: it cannot speak, read the roster's authority detail, or claim.
      expect(
        (
          await request(
            'POST',
            '/teams/bravo/messages',
            { act: 'message', body: 'I am a machine pretending to be a teammate' },
            nodeCredential,
          )
        ).status,
      ).toBe(401);
      expect((await request('GET', '/teams/bravo/inbox', undefined, nodeCredential)).status).toBe(
        401,
      );
    });

    it('invite, rotate, revoke and list are admin-only', async () => {
      const paths: [string, string][] = [
        ['POST', '/teams/bravo/nodes/invite'],
        ['POST', '/teams/bravo/nodes/node-remote/rotate'],
        ['POST', '/teams/bravo/nodes/node-remote/revoke'],
        ['GET', '/teams/bravo/nodes'],
      ];

      for (const [method, path] of paths) {
        // No credential at all.
        expect((await request(method, path)).status, `${method} ${path} unauthenticated`).toBe(401);
        // A genuinely AUTHENTICATED non-admin seat — ada, an ordinary agent. The seat header matters:
        // a bare agent key resolves to no member and 401s on every route, which would make this
        // assertion pass without ever exercising the admin gate.
        const res = await request(method, path, undefined, adaAuth);
        expect(res.status, `${method} ${path} as non-admin seat`).toBe(403);
      }
    });

    it('rotation retires the old credential and keeps the node id', async () => {
      const code = await invite();
      const joined = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });
      const old = joined.json.node_credential;

      const rotated = await request(
        'POST',
        '/teams/bravo/nodes/node-remote/rotate',
        undefined,
        nickCredential,
      );
      expect(rotated.status).toBe(200);
      expect(rotated.json.node_credential).toMatch(/^msnode_/);
      expect(rotated.json.node_credential).not.toBe(old);

      const team = (await getTeamBySlug(server.store, 'bravo'))!;
      const row = await server.store.get('SELECT id FROM nodes WHERE team_id = ? AND id = ?', [
        team.id,
        'node-remote',
      ]);
      expect(row?.id).toBe('node-remote');
    });

    it('revocation is recorded, and a second revoke reports that it changed nothing', async () => {
      const code = await invite();
      await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });

      const first = await request(
        'POST',
        '/teams/bravo/nodes/node-remote/revoke',
        undefined,
        nickCredential,
      );
      expect(first.status).toBe(200);
      expect(first.json.revoked).toBe(true);

      const second = await request(
        'POST',
        '/teams/bravo/nodes/node-remote/revoke',
        undefined,
        nickCredential,
      );
      expect(second.json.revoked).toBe(false);

      // A revoked node cannot be rotated back into service.
      expect(
        (await request('POST', '/teams/bravo/nodes/node-remote/rotate', undefined, nickCredential))
          .status,
      ).toBe(409);
    });

    it('the listing names nodes without handing over any part of a secret', async () => {
      const code = await invite();
      const joined = await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });
      const secret = joined.json.node_credential;

      const listed = await request('GET', '/teams/bravo/nodes', undefined, nickCredential);
      expect(listed.status).toBe(200);

      const body = JSON.stringify(listed.json);
      expect(body).not.toContain(secret);
      expect(body).not.toContain('credential_hash');
      const remote = listed.json.nodes.find((n: any) => n.id === 'node-remote');
      expect(remote.credential_prefix).toBe('msnode_');
      expect(remote.label).toBe('laptop');
    });
  });

  describe('host unbind (lane 01M5E1Z7JE, ADR 689 d5 follow-up)', () => {
    /** A host label bound to `node-remote`, the way a joiner's first host-actor push binds it. */
    async function boundLabel(label = 'cloud-ada'): Promise<string> {
      const code = await invite();
      await request('POST', '/teams/bravo/nodes/join', {
        code,
        node_id: 'node-remote',
        label: 'laptop',
      });
      const team = (await getTeamBySlug(server.store, 'bravo'))!;
      expect(await bindHostToNode(server.store, team.id, label, 'node-remote')).toEqual({
        bound: true,
      });
      return team.id;
    }

    async function bindingOf(teamId: string, label: string): Promise<string | null> {
      const row = await server.store.get<{ node: string | null }>(
        'SELECT node FROM host_liveness WHERE team_id = ? AND host = ?',
        [teamId, label],
      );
      return row?.node ?? null;
    }

    async function unbindAudit(teamId: string) {
      return await server.store.all<{ result: string; target: string; detail: string }>(
        `SELECT result, target, detail FROM audit WHERE team_id = ? AND action = 'host.unbound'
          ORDER BY ts, id`,
        [teamId],
      );
    }

    it('is admin-only', async () => {
      await boundLabel();
      const res = await request('POST', '/teams/bravo/hosts/cloud-ada/unbind', undefined, adaAuth);
      expect(res.status).toBe(403);
    });

    it('clears the binding so another node takes the label on its next push, and is audited', async () => {
      const teamId = await boundLabel();
      const res = await request(
        'POST',
        '/teams/bravo/hosts/cloud-ada/unbind',
        undefined,
        nickCredential,
      );
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ host: 'cloud-ada', unbound: true, node_id: 'node-remote' });
      expect(await bindingOf(teamId, 'cloud-ada')).toBeNull();
      expect(await bindHostToNode(server.store, teamId, 'cloud-ada', 'node-real')).toEqual({
        bound: true,
      });

      const rows = await unbindAudit(teamId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result).toBe('allow');
      expect(JSON.parse(rows[0]!.detail)).toEqual({ node: 'node-remote' });
    });

    it('reports that an unbound or unknown label changed nothing', async () => {
      const teamId = await boundLabel();
      const res = await request(
        'POST',
        '/teams/bravo/hosts/nowhere/unbind',
        undefined,
        nickCredential,
      );
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ host: 'nowhere', unbound: false });
      expect(await unbindAudit(teamId)).toHaveLength(0);
    });

    it('refuses while the bound node is live and seats are enrolled on the label, until the node is revoked', async () => {
      const teamId = await boundLabel();
      const ada = (await getMemberByName(server.store, teamId, 'ada'))!;
      await applyFoldedEnrollment(server.store, teamId, {
        member_id: ada.id,
        harness: 'claude-code',
        host: 'cloud-ada',
        authorized_by: 'nick',
      });

      const refused = await request(
        'POST',
        '/teams/bravo/hosts/cloud-ada/unbind',
        undefined,
        nickCredential,
      );
      expect(refused.status).toBe(409);
      expect(refused.json.error.message).toMatch(
        /node-remote.*ada.*musterd node revoke node-remote/,
      );
      expect(await bindingOf(teamId, 'cloud-ada')).toBe('node-remote');
      const denied = await unbindAudit(teamId);
      expect(denied).toHaveLength(1);
      expect(denied[0]!.result).toBe('deny');
      expect(JSON.parse(denied[0]!.detail)).toEqual({
        node: 'node-remote',
        reason: 'in_use',
        seats: ['ada'],
      });

      await request('POST', '/teams/bravo/nodes/node-remote/revoke', undefined, nickCredential);
      const after = await request(
        'POST',
        '/teams/bravo/hosts/cloud-ada/unbind',
        undefined,
        nickCredential,
      );
      expect(after.status).toBe(200);
      expect(after.json.unbound).toBe(true);
      expect(await bindingOf(teamId, 'cloud-ada')).toBeNull();
    });
  });
});
