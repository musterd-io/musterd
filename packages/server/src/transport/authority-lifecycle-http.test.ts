import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/**
 * ADR 662 decision 6 over HTTP (lane 01M5ANFKEVTENBNVG9JQKA965N): a human enrolls their
 * first key with a one-time code from their own credential; from that moment their Bearer
 * alone no longer performs a listed act. An agent seat cannot even mint a code.
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

  it('enroll by code latches the gate; the key lists and revokes by code', async () => {
    // An agent seat gets no code and no keys.
    expect((await call('POST', '/teams/dawn/authority/enrollment-codes', ada)).status).toBe(403);

    const issued = await call('POST', '/teams/dawn/authority/enrollment-codes', nick);
    expect(issued.status).toBe(201);
    const { publicKey } = generateKeyPairSync('ed25519');
    const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');

    // A wrong code enrolls nothing.
    const bad = await call('POST', '/teams/dawn/authority/keys', nick, {
      public_key,
      kind: 'platform',
      enrollment_code: 'wrong-code',
    });
    expect(bad.status).toBe(422);

    const enrolled = await call('POST', '/teams/dawn/authority/keys', nick, {
      public_key,
      kind: 'platform',
      enrollment_code: issued.json.code,
    });
    expect(enrolled.status).toBe(201);
    const keyId = enrolled.json.key.id as string;

    const listed = await call('GET', '/teams/dawn/authority/keys', nick);
    expect(listed.json.keys).toEqual([
      { id: keyId, kind: 'platform', created_at: expect.any(Number), revoked_at: null },
    ]);

    // The gate is latched now: nick's Bearer alone is refused on a listed act.
    const refused = await call('POST', '/teams/dawn/policy', nick, { doorbell: { allow: [] } });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');

    // Revoke the only key by a fresh code (the lost-device path).
    const code2 = await call('POST', '/teams/dawn/authority/enrollment-codes', nick);
    const revoked = await call('POST', `/teams/dawn/authority/keys/${keyId}/revoke`, nick, {
      enrollment_code: code2.json.code,
    });
    expect(revoked.status).toBe(200);
    const after = await call('GET', '/teams/dawn/authority/keys', nick);
    expect(after.json.keys[0].revoked_at).toEqual(expect.any(Number));
  });
});
