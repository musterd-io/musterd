import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { enrollDeviceKey } from '../store/authority.js';
import { getMemberByName } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * ADR 662 decision 6 over HTTP (lane 01M5ANFKEVTENBNVG9JQKA965N, passkey-first):
 * lazara's HA2 attack as a falsifier — an agent holding the human's config.json
 * Bearer can mint a ceremony challenge, but can enroll no key with it, revoke
 * nothing with it, and perform no listed act. Enrollment is a user-verified
 * passkey ceremony (first key / recovery) or a standing key's signature.
 */
withDrivers('authority-lifecycle-http (ADR 662)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;

  async function call(method: string, path: string, auth: string | AgentHttpAuth, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}`,
        ...(typeof auth === 'object'
          ? { 'x-musterd-session-lease': auth.sessionLease, 'x-musterd-seat': 'ada' }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const team = await call('POST', '/teams', '', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    nick = team.json.human_credential;
    await call('POST', '/teams/dawn/members', nick, { name: 'ada', kind: 'agent' });
    ada = await claimAgentHttp(base, 'dawn', team.json.agent_key, nick, 'ada');
  });

  afterEach(async () => {
    await server.close();
  });

  it('the config.json attack enrolls nothing and performs no listed act', async () => {
    // An agent seat gets no challenge and no keys.
    expect((await call('POST', '/teams/dawn/authority/enrollment-challenges', ada)).status).toBe(
      403,
    );
    // The old code endpoint is gone.
    expect((await call('POST', '/teams/dawn/authority/enrollment-codes', nick)).status).toBe(404);

    // The attacker holds nick's Bearer and mints a challenge: that alone enrolls nothing.
    const issued = await call('POST', '/teams/dawn/authority/enrollment-challenges', nick);
    expect(issued.status).toBe(201);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');

    const enroll = await call('POST', '/teams/dawn/authority/keys', nick, {
      public_key,
      kind: 'platform',
    });
    expect(enroll.status).toBe(422);
    expect(JSON.stringify(enroll.json)).toContain('passkey_first');
    expect((await call('GET', '/teams/dawn/authority/keys', nick)).json.keys).toEqual([]);

    // Nick enrolls a real key (the ceremony itself is covered at store level);
    // from here the Bearer alone performs no listed act and revokes nothing.
    const teamRow = (await getTeamBySlug(server.store, 'dawn'))!;
    const nickRow = (await getMemberByName(server.store, teamRow.id, 'nick'))!;
    const key = await enrollDeviceKey(server.store, {
      teamId: teamRow.id,
      memberId: nickRow.id,
      publicKey: public_key,
      kind: 'platform',
    });

    const refused = await call('POST', '/teams/dawn/policy', nick, { doorbell: { allow: [] } });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');

    const revoke = await call('POST', `/teams/dawn/authority/keys/${key.id}/revoke`, nick, {});
    expect(revoke.status).toBe(422);
    const listed = await call('GET', '/teams/dawn/authority/keys', nick);
    expect(listed.json.keys[0].revoked_at).toBeNull();

    // The standing key signs a descriptor and the act goes through exactly once.
    const desc = await call('POST', '/teams/dawn/authority/descriptors', nick, {
      act: 'admin.team_policy',
      target: 'dawn',
      payload: { doorbell: { allow: [] } },
    });
    expect(desc.status).toBe(201);
    const d = desc.json.descriptor as ApprovalDescriptor;
    const signature = cryptoSign(
      null,
      Buffer.from(descriptorSigningBytes(d), 'utf8'),
      privateKey,
    ).toString('base64url');
    const ok = await call('POST', '/teams/dawn/policy', nick, {
      doorbell: { allow: [] },
      approval: { key_id: key.id, nonce: d.nonce, signature },
    });
    expect(ok.status).toBe(200);
  });
});
