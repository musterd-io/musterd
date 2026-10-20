import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  AppPairingQrSchema,
  descriptorSigningBytes,
  type ApprovalDescriptor,
} from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import {
  __setAppChannelKeysForTest,
  generateAppChannelKeys,
  generatePhoneReceiveKey,
  sealToDaemon,
  type AppChannelKeys,
} from '../notify/appSeal.js';
import { appPairingChallenge } from '../store/appAttest.js';
import { fakeAppAttest } from '../store/appAttest.testkit.js';
import { stageAppPairing } from '../store/appPairing.js';
import { enrollDeviceKey } from '../store/authority.js';
import { getMemberByName } from '../store/members.js';
import { getTeamBySlug, setPolicy } from '../store/teams.js';

const APP_ID = 'ABCDE12345.io.musterd.app';

withDrivers('app pairing over HTTP (ADR 676 §5)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let daemon: AppChannelKeys;

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nick}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    daemon = await generateAppChannelKeys();
    __setAppChannelKeysForTest(daemon);
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const res = await fetch(`${base}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
    });
    nick = ((await res.json()) as { human_credential: string }).human_credential;
  });

  afterEach(async () => {
    __setAppChannelKeysForTest(null);
    await server.close();
  });

  it('QR on the daemon page → staged phone → standing key confirms → app binding', async () => {
    // No relay, no pairing: the phone would have nowhere to answer.
    expect((await call('POST', '/teams/dawn/channels/app/pairing')).status).toBe(422);

    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    await setPolicy(server.store, team.id, {
      away_relay_url: 'https://relay.example',
      away_relay_token: 'relay-credential-for-tests',
    });
    const started = await call('POST', '/teams/dawn/channels/app/pairing');
    expect(started.status).toBe(201);
    const qr = AppPairingQrSchema.parse(started.json.qr);
    expect(qr.daemon_identity_public_key).toBe(daemon.identityPublic);
    expect(started.json.daemon_fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);

    // The phone's sealed request (it arrives through the relay; staged directly here).
    const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = signing.publicKey.export({ format: 'jwk' });
    const signingRaw = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    const receive = await generatePhoneReceiveKey();
    const f = fakeAppAttest({
      appId: APP_ID,
      clientDataHash: appPairingChallenge(
        qr.code,
        signingRaw,
        Buffer.from(receive.publicRaw, 'base64url'),
      ),
      now: Date.now(),
    });
    const sealed = await sealToDaemon({
      daemonReceivePublic: qr.daemon_receive_public_key,
      route: { team: qr.team, binding: 'pairing', ref: qr.pairing, expires_at: qr.expires_at },
      payload: new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          code: qr.code,
          signing_public_key: signingRaw.toString('base64url'),
          receive_public_key: receive.publicRaw,
          attest_key_id: f.keyId.toString('base64url'),
          attestation: f.attestation.toString('base64url'),
        }),
      ),
      purpose: 'pair',
    });
    const staged = await stageAppPairing(server.store, {
      teamId: team.id,
      teamSlug: team.slug,
      pairingId: qr.pairing,
      sealed,
      keys: daemon,
      appId: APP_ID,
      attestRoots: [f.root],
    });
    expect(staged.ok).toBe(true);

    const pending = await call('GET', '/teams/dawn/channels/pairings');
    const app = pending.json.pairings[0].app;
    expect(app.enroll_payload).toMatchObject({ action: 'enroll', kind: 'phone' });
    expect(JSON.stringify(pending.json)).not.toContain(qr.code);

    // nick already has a standing key (the passkey suite enrolls it by ceremony).
    const member = (await getMemberByName(server.store, team.id, 'nick'))!;
    const standing = generateKeyPairSync('ed25519');
    const key = await enrollDeviceKey(server.store, {
      teamId: team.id,
      memberId: member.id,
      publicKey: standing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      kind: 'platform',
    });

    // Confirming without the standing key's signature binds nothing.
    const bare = await call('POST', `/teams/dawn/channels/pairings/${qr.pairing}/confirm`);
    expect(bare.status).toBe(403);

    const desc = await call('POST', '/teams/dawn/authority/descriptors', {
      act: 'device_key_admin',
      target: 'nick',
      payload: app.enroll_payload,
    });
    expect(desc.status).toBe(201);
    const d = desc.json.descriptor as ApprovalDescriptor;
    const signature = cryptoSign(
      null,
      Buffer.from(descriptorSigningBytes(d), 'utf8'),
      standing.privateKey,
    ).toString('base64url');
    const confirmed = await call('POST', `/teams/dawn/channels/pairings/${qr.pairing}/confirm`, {
      approval: { key_id: key.id, nonce: d.nonce, signature },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.binding).toMatchObject({ channel: 'app', status: 'active' });
    expect(confirmed.json.device_key_id).toBeTruthy();
  });

  it('a phone key never enrolls through the generic key route, and the generic start refuses the app', async () => {
    const enroll = await call('POST', '/teams/dawn/authority/keys', {
      public_key: 'AAAA',
      kind: 'phone',
    });
    expect(enroll.status).toBe(422);
    expect(enroll.json.error.message).toContain('pairing the musterd app');
    const start = await call('POST', '/teams/dawn/channels/pairing/start', { channel: 'app' });
    expect(start.status).toBe(422);
  });
});
