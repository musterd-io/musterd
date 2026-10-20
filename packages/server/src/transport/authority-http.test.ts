import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { enrollDeviceKey, issueEnrollmentChallenge } from '../store/authority.js';
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

  it('roster add: an enrolled human’s Bearer mints no new human; a signed add does', async () => {
    const refused = await call('POST', '/teams/dawn/members', nick, {
      name: 'mallory',
      kind: 'human',
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toContain('no_signature');

    const payload = { name: 'mallory', kind: 'human', role: null, observer: false };
    const d = await descriptor('admin.roster', 'mallory', payload);
    const proof = { key_id: keyId, nonce: d.nonce, signature: signWith(d) };
    const ok = await call('POST', '/teams/dawn/members', nick, {
      name: 'mallory',
      kind: 'human',
      approval: proof,
    });
    expect(ok.status).toBe(201);
  });

  it('roster remove, credential mints and team archive all refuse an unsigned Bearer', async () => {
    const removed = await call('POST', '/teams/dawn/members/ada/remove', nick, {});
    expect(removed.status).toBe(403);
    expect(JSON.stringify(removed.json)).toContain('no_signature');

    const bootstrap = await call('POST', '/teams/dawn/agent-bootstrap-credentials', nick, {
      use: 'host',
      target: 'host-1',
    });
    expect(bootstrap.status).toBe(403);
    expect(JSON.stringify(bootstrap.json)).toContain('no_signature');

    const agentKey = await call('POST', '/teams/dawn/agent-key/rotate', nick, {});
    expect(agentKey.status).toBe(403);
    expect(JSON.stringify(agentKey.json)).toContain('no_signature');

    const credRotate = await call('POST', '/teams/dawn/members/nick/credential/rotate', nick, {});
    expect(credRotate.status).toBe(403);
    expect(JSON.stringify(credRotate.json)).toContain('no_signature');

    const archived = await call('POST', '/teams/dawn/archive', nick, {});
    expect(archived.status).toBe(403);
    expect(JSON.stringify(archived.json)).toContain('no_signature');
  });

  it('a signed credential mint goes through', async () => {
    const payload = { action: 'agent_key_rotate' };
    const d = await descriptor('credential_mint', 'dawn', payload);
    const proof = { key_id: keyId, nonce: d.nonce, signature: signWith(d) };
    const ok = await call('POST', '/teams/dawn/agent-key/rotate', nick, { approval: proof });
    expect(ok.status).toBe(200);
  });

  it('passkey enrollment refuses an origin that matches only its own spoofed Host header', async () => {
    // Stanley's falsifier: before the fix, webauthnExpectedOrigins unioned
    // requestOrigin(req) — Host/X-Forwarded-Proto — so a ceremony whose
    // claimed origin matched its own headers passed its own origin check.
    const teamRow = (await getTeamBySlug(server.store, 'dawn'))!;
    // A fresh human with no standing key: before the fix her ceremony verified
    // (origin allowed via headers) and only failed later at countersign; after
    // the fix it must fail at registration with bad_registration.
    const { addMember } = await import('../store/members.js');
    const mallory = (await addMember(server.store, teamRow, { name: 'mallory', kind: 'human' }))
      .row;
    const issued = await issueEnrollmentChallenge(server.store, {
      teamId: teamRow.id,
      memberId: mallory.id,
      actor: 'mallory',
    });
    const head = (major: number, len: number): Buffer =>
      len < 24 ? Buffer.from([(major << 5) | len]) : Buffer.from([(major << 5) | 24, len]);
    const encInt = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
    const encBytes = (b: Uint8Array) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
    const encText = (s: string) => {
      const b = Buffer.from(s, 'utf8');
      return Buffer.concat([head(3, b.length), b]);
    };
    const encMap = (entries: [Uint8Array, Uint8Array][]) =>
      Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);
    const { publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    const cose = encMap([
      [encInt(1), encInt(1)],
      [encInt(3), encInt(-8)],
      [encInt(-1), encInt(6)],
      [encInt(-2), encBytes(Buffer.from(jwk.x, 'base64url'))],
    ]);
    const credId = Buffer.from('evil-credential');
    // Host must pass the daemon's Host allowlist, so claim its own loopback
    // origin on the test port — an origin config never listed (config pins
    // the daemon's configured port, not this ephemeral one).
    const claimedOrigin = `http://localhost:${Number(new URL(base).port)}`;
    const rpHash = createHash('sha256').update('localhost').digest();
    const authData = Buffer.concat([
      rpHash,
      Buffer.from([0x45]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.alloc(16),
      Buffer.from([0, credId.length]),
      credId,
      cose,
    ]);
    const attestationObject = encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(authData)],
    ]);
    // Raw http.request: fetch/undici will not send a caller-chosen Host header.
    const { request } = await import('node:http');
    const port = Number(new URL(base).port);
    const bodyText = JSON.stringify({
      actor: 'mallory',
      challenge: issued.challenge,
      registration: {
        attestation_object: attestationObject.toString('base64url'),
        client_data_json: JSON.stringify({
          type: 'webauthn.create',
          challenge: issued.challenge,
          origin: claimedOrigin,
          crossOrigin: false,
        }),
      },
    });
    const res = await new Promise<{ status: number; text: string }>((resolveReq, rejectReq) => {
      const r = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/teams/dawn/authority/passkeys',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(bodyText),
            host: `localhost:${port}`,
            'x-forwarded-proto': 'http',
          },
        },
        (resp) => {
          let text = '';
          resp.on('data', (c) => (text += c));
          resp.on('end', () => resolveReq({ status: resp.statusCode ?? 0, text }));
        },
      );
      r.on('error', rejectReq);
      r.end(bodyText);
    });
    expect(res.status).toBe(422);
    expect(res.text).toContain('bad_registration');
    const keys = await call('GET', '/teams/dawn/authority/keys', nick);
    expect(keys.json.keys.filter((k: { kind: string }) => k.kind === 'passkey')).toHaveLength(0);
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
