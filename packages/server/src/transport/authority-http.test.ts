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
 * ADR 662's eval at the transport edge (lane 01M5ANFFVHY07ZTYEECTRSTXTN): nick has an
 * enrolled device key; the attacker is an agent holding nick's config.json credential —
 * which is to say, nick's own Bearer. Every listed act attempted with it, and no signature,
 * must be refused; the same acts with a fresh signature over the server-built descriptor
 * must go through exactly once.
 */
withDrivers('authority-http (ADR 662)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;
  let keyId: string;
  let signWith: (d: ApprovalDescriptor) => string;

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

  async function descriptor(act: string, target: string, payload: unknown) {
    const res = await call('POST', '/teams/dawn/authority/descriptors', nick, {
      act,
      target,
      payload,
    });
    expect(res.status).toBe(201);
    return res.json.descriptor as ApprovalDescriptor;
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
    const teamRow = (await getTeamBySlug(server.store, 'dawn'))!;
    const nickRow = (await getMemberByName(server.store, teamRow.id, 'nick'))!;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    signWith = (d) =>
      cryptoSign(null, Buffer.from(descriptorSigningBytes(d), 'utf8'), privateKey).toString(
        'base64url',
      );
    const key = await enrollDeviceKey(server.store, {
      teamId: teamRow.id,
      memberId: nickRow.id,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      kind: 'platform',
    });
    keyId = key.id;
  });

  afterEach(async () => {
    await server.close();
  });

  it('team policy: refused without a signature, accepted with one, never twice', async () => {
    const policy = { doorbell: { allow: ['live'] } };
    const refused = await call('POST', '/teams/dawn/policy', nick, policy);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');

    const d = await descriptor('admin.team_policy', 'dawn', policy);
    const proof = { key_id: keyId, nonce: d.nonce, signature: signWith(d) };
    const ok = await call('POST', '/teams/dawn/policy', nick, { ...policy, approval: proof });
    expect(ok.status).toBe(200);
    const replay = await call('POST', '/teams/dawn/policy', nick, { ...policy, approval: proof });
    expect(replay.status).toBe(403);
    expect(JSON.stringify(replay.json)).toContain('nonce_reused');
  });

  it('grant issue on the admin path is refused without a signature', async () => {
    const refused = await call('POST', '/teams/dawn/grants', nick, {
      scope: 'role',
      target: 'security',
      lifetime: 'standing',
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');
  });

  it('a human counterpart close needs the signature; the signed close lands', async () => {
    const opened = await call('POST', '/teams/dawn/lanes', ada, { title: 'verdict lane' });
    expect(opened.status).toBe(201);
    const laneId = opened.json.lane.id as string;
    const submitted = await call('PATCH', `/teams/dawn/lanes/${laneId}`, ada, {
      state: 'awaiting_acceptance',
    });
    expect(submitted.status).toBe(200);

    // Nick is the enrolled human counterpart: his Bearer alone no longer closes the lane.
    const refused = await call('PATCH', `/teams/dawn/lanes/${laneId}`, nick, {
      state: 'done',
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');

    const d = await descriptor('human_accept', laneId, { lane: laneId, verdict: 'done' });
    const proof = { key_id: keyId, nonce: d.nonce, signature: signWith(d) };
    const closed = await call('PATCH', `/teams/dawn/lanes/${laneId}`, nick, {
      state: 'done',
      approval: proof,
    });
    expect(closed.status).toBe(200);
    expect(closed.json.lane.state).toBe('done');
  });
});
