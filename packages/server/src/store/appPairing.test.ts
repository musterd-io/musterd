import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  __setAppChannelKeysForTest,
  generateAppChannelKeys,
  generatePhoneReceiveKey,
  sealToDaemon,
  type AppChannelKeys,
} from '../notify/appSeal.js';
import { appPairingChallenge } from './appAttest.js';
import { fakeAppAttest } from './appAttest.testkit.js';
import {
  appBindingEnded,
  appBindingKeys,
  appEnrollPayload,
  confirmAppPairing,
  stageAppPairing,
  stagedAppKeys,
  startAppPairing,
  UNKNOWN_DAEMON_KEY,
  phoneKeyPairingEnded,
  revokePhoneKeysOfEndedBindings,
  revokePhoneKeysOfEndedBindingsEverywhere,
} from './appPairing.js';
import { listAuditByAction } from './audit.js';
import {
  buildDescriptor,
  enrollDeviceKey,
  activeDeviceKeys,
  getDeviceKey,
  listDeviceKeys,
  requireAuthority,
} from './authority.js';
import {
  confirmPairing,
  killSwitchChannels,
  recordPairingIdentity,
  revokeBinding,
} from './channelBindings.js';
import { getChannelSettings } from './channelSettings.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

const NOW = 1_800_000_000_000;
const APP_ID = 'ABCDE12345.io.musterd.app';
let openStore: () => Promise<Driver>;

function standingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: (d: ApprovalDescriptor) =>
      cryptoSign(null, Buffer.from(descriptorSigningBytes(d), 'utf8'), privateKey).toString(
        'base64url',
      ),
  };
}

/** The phone: a P-256 signing key (DER signatures, as SecKey produces) and a receive key. */
async function phone() {
  const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = signing.publicKey.export({ format: 'jwk' });
  const signingRaw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  const receive = await generatePhoneReceiveKey();
  return {
    signingRaw,
    receive,
    sign: (d: ApprovalDescriptor) =>
      cryptoSign(
        'sha256',
        Buffer.from(descriptorSigningBytes(d), 'utf8'),
        signing.privateKey,
      ).toString('base64url'),
  };
}

async function setup() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const daemon = await generateAppChannelKeys();
  // Lane 01M6Q1RDTK: the authority boundary reads the daemon's current key to decide whether a
  // phone key's pairing stands; in-memory tests must see these keys, not the home directory's.
  __setAppChannelKeysForTest(daemon);
  return { db, team, nick, daemon };
}

async function pairRequest(
  daemon: AppChannelKeys,
  qr: { team: string; pairing: string; code: string; expires_at: number },
  p: Awaited<ReturnType<typeof phone>>,
  over: { appId?: string; code?: string; ref?: string } = {},
) {
  const code = over.code ?? qr.code;
  const f = fakeAppAttest({
    appId: over.appId ?? APP_ID,
    clientDataHash: appPairingChallenge(
      code,
      p.signingRaw,
      Buffer.from(p.receive.publicRaw, 'base64url'),
    ),
    now: NOW,
  });
  const body = {
    v: 1,
    code,
    signing_public_key: p.signingRaw.toString('base64url'),
    receive_public_key: p.receive.publicRaw,
    attest_key_id: f.keyId.toString('base64url'),
    attestation: f.attestation.toString('base64url'),
    device_name: "nick's iPhone",
  };
  const sealed = await sealToDaemon({
    daemonReceivePublic: daemon.receivePublic,
    route: {
      team: qr.team,
      binding: 'pairing',
      ref: over.ref ?? qr.pairing,
      expires_at: qr.expires_at,
    },
    payload: new TextEncoder().encode(JSON.stringify(body)),
    purpose: 'pair',
  });
  return { sealed, root: f.root };
}

withDrivers('app pairing (ADR 676 §5)', (o) => {
  beforeEach(() => {
    openStore = o;
  });
  afterEach(() => __setAppChannelKeysForTest(null));

  it('QR → sealed attested request → standing key approves → binding with the phone keys', async () => {
    const { db, team, nick, daemon } = await setup();
    const k1 = standingKey();
    const key1 = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: k1.publicKey,
      kind: 'platform',
    });
    const { pairing, qr } = await startAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      memberId: nick.id,
      actor: 'nick',
      relayUrl: 'https://relay.example',
      keys: daemon,
      now: NOW,
    });
    expect(qr).toMatchObject({
      v: 1,
      team: 'revive',
      pairing: pairing.id,
      daemon_identity_public_key: daemon.identityPublic,
      daemon_receive_public_key: daemon.receivePublic,
    });

    const p = await phone();
    const { sealed, root } = await pairRequest(daemon, qr, p);
    const staged = await stageAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      pairingId: pairing.id,
      sealed,
      keys: daemon,
      appId: APP_ID,
      now: NOW,
      attestRoots: [root],
    });
    expect(staged).toMatchObject({ ok: true, pairing: { state: 'awaiting_confirmation' } });
    const keys = (await stagedAppKeys(db, team.id, pairing.id))!;
    expect(keys).toMatchObject({ environment: 'production', device_name: "nick's iPhone" });

    // Without a standing key's signature nothing is bound, and the pairing stays confirmable.
    const base = {
      teamId: team.id,
      audience: team.slug,
      member: nick,
      pairingId: pairing.id,
      now: NOW,
    };
    await expect(confirmAppPairing(db, base)).resolves.toEqual({
      ok: false,
      reason: 'no_signature',
    });

    const d = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: appEnrollPayload(keys),
      now: NOW,
    });
    const done = await confirmAppPairing(db, {
      ...base,
      proof: { key_id: key1.id, nonce: d.nonce, signature: k1.sign(d) },
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.binding).toMatchObject({ channel: 'app', member_id: nick.id, status: 'active' });
    const bound = await appBindingKeys(db, team.id, done.binding.id);
    expect(bound).toMatchObject({
      receive_public_key: p.receive.publicRaw,
      device_key_id: done.deviceKeyId,
      // ADR 802 §1: the key the phone pinned from the QR rides on the binding.
      daemon_identity_public_key: daemon.identityPublic,
    });
    const phoneKey = (await listDeviceKeys(db, team.id, nick.id)).find(
      (k) => k.id === done.deviceKeyId,
    );
    expect(phoneKey?.kind).toBe('phone');

    // ADR 759: confirming is the opt-in, so the app channel delivers and answers from here on,
    // still only while the human is away.
    expect(await getChannelSettings(db, team.id, nick.id, 'app')).toEqual({
      channel: 'app',
      deliver: true,
      answer: true,
      presenceGating: true,
      tierFloor: null,
    });

    const rows = (await listAuditByAction(db, team.id, 'channel.app_paired', 100)).reverse();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: 'allow', target: done.binding.id });
    expect(JSON.stringify(rows)).not.toContain(qr.code);
    expect(JSON.stringify(rows)).not.toContain(p.receive.publicRaw);

    // The enrolled phone key signs a listed act with a P-256 DER signature, and it passes A2.
    const act = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'revoke', key_id: key1.id },
      now: NOW,
    });
    const check = await requireAuthority(db, {
      teamId: team.id,
      audience: team.slug,
      presenter: nick,
      credential: 'human',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'revoke', key_id: key1.id },
      proof: { key_id: done.deviceKeyId, nonce: act.nonce, signature: p.sign(act) },
      now: NOW,
    });
    expect(check.ok).toBe(true);
  });

  it('a passkey standing key confirms when the caller supplies WebAuthn origins', async () => {
    const { db, team, nick, daemon } = await setup();
    const passkey = generateKeyPairSync('ed25519');
    const credentialRaw = Buffer.from('nick-passkey-credential');
    const standing = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: nick.id,
      publicKey: passkey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      kind: 'passkey',
      credentialId: credentialRaw.toString('base64url'),
      now: NOW,
    });
    const { pairing, qr } = await startAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      memberId: nick.id,
      actor: 'nick',
      relayUrl: 'https://relay.example',
      keys: daemon,
      now: NOW,
    });
    const p = await phone();
    const { sealed, root } = await pairRequest(daemon, qr, p);
    const staged = await stageAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      pairingId: pairing.id,
      sealed,
      keys: daemon,
      appId: APP_ID,
      now: NOW,
      attestRoots: [root],
    });
    expect(staged.ok).toBe(true);
    const keys = (await stagedAppKeys(db, team.id, pairing.id))!;
    const descriptor = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      act: 'device_key_admin',
      target: 'nick',
      payload: appEnrollPayload(keys),
      now: NOW,
    });
    const origin = 'https://example.com';
    const rpIdHash = createHash('sha256').update('example.com').digest();
    const flags = Buffer.from([0x01]);
    const signCount = Buffer.alloc(4);
    const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);
    const clientDataJson = JSON.stringify({
      type: 'webauthn.get',
      challenge: descriptor.nonce,
      origin,
      crossOrigin: false,
    });
    const clientHash = createHash('sha256').update(clientDataJson).digest();
    const signature = cryptoSign(
      null,
      Buffer.concat([authenticatorData, clientHash]),
      passkey.privateKey,
    ).toString('base64url');
    const done = await confirmAppPairing(db, {
      teamId: team.id,
      audience: team.slug,
      member: nick,
      pairingId: pairing.id,
      now: NOW,
      expectedOrigins: [origin],
      proof: {
        key_id: standing.id,
        nonce: descriptor.nonce,
        signature,
        authenticator_data: authenticatorData.toString('base64url'),
        client_data_json: clientDataJson,
      },
    });
    expect(done).toEqual(expect.objectContaining({ ok: true }));
  });

  it('a phone cannot be the first key: a human with none standing gets passkey_first', async () => {
    const { db, team, nick, daemon } = await setup();
    const { pairing, qr } = await startAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      memberId: nick.id,
      actor: 'nick',
      relayUrl: 'https://relay.example',
      keys: daemon,
      now: NOW,
    });
    const { sealed, root } = await pairRequest(daemon, qr, await phone());
    await stageAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      pairingId: pairing.id,
      sealed,
      keys: daemon,
      appId: APP_ID,
      now: NOW,
      attestRoots: [root],
    });
    await expect(
      confirmAppPairing(db, {
        teamId: team.id,
        audience: team.slug,
        member: nick,
        pairingId: pairing.id,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: 'passkey_first' });
  });

  it('a forged attestation, a wrong code or a body sealed for another pairing is refused once and kills the pairing', async () => {
    const { db, team, nick, daemon } = await setup();
    const start = () =>
      startAppPairing(db, {
        teamId: team.id,
        teamSlug: team.slug,
        memberId: nick.id,
        actor: 'nick',
        relayUrl: 'https://relay.example',
        keys: daemon,
        now: NOW,
      });
    const stage = (pairingId: string, sealed: Awaited<ReturnType<typeof pairRequest>>) =>
      stageAppPairing(db, {
        teamId: team.id,
        teamSlug: team.slug,
        pairingId,
        sealed: sealed.sealed,
        keys: daemon,
        appId: APP_ID,
        now: NOW,
        attestRoots: [sealed.root],
      });

    const a = await start();
    const forged = await pairRequest(daemon, a.qr, await phone(), { appId: 'ZZZZZ99999.com.evil' });
    await expect(stage(a.pairing.id, forged)).resolves.toEqual({
      ok: false,
      reason: 'app_id_mismatch',
    });
    // One try: an honest retry on the same pairing is dead too.
    const retry = await pairRequest(daemon, a.qr, await phone());
    await expect(stage(a.pairing.id, retry)).resolves.toEqual({ ok: false, reason: 'consumed' });

    const b = await start();
    const wrongCode = await pairRequest(daemon, b.qr, await phone(), { code: 'x'.repeat(43) });
    await expect(stage(b.pairing.id, wrongCode)).resolves.toEqual({
      ok: false,
      reason: 'code_mismatch',
    });

    const c = await start();
    const d = await start();
    const moved = await pairRequest(daemon, c.qr, await phone());
    await expect(stage(d.pairing.id, moved)).resolves.toEqual({ ok: false, reason: 'sealed_body' });

    const denies = (await listAuditByAction(db, team.id, 'channel.app_paired', 100)).reverse();
    expect(denies.map((r) => r.result)).toEqual(['deny', 'deny', 'deny']);
    expect(JSON.stringify(denies)).not.toContain(a.qr.code);
  });

  it('the generic pairing paths refuse an app pairing', async () => {
    const { db, team, nick, daemon } = await setup();
    const { pairing, qr } = await startAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      memberId: nick.id,
      actor: 'nick',
      relayUrl: 'https://relay.example',
      keys: daemon,
      now: NOW,
    });
    // A relay that learned the code cannot stage a provider identity on it…
    await expect(
      recordPairingIdentity(db, {
        nonce: qr.code,
        providerTenantId: 't',
        providerUserId: 'u',
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: 'app_pairing' });
    // …and a staged app pairing cannot be confirmed without enrolling the phone key.
    const { sealed, root } = await pairRequest(daemon, qr, await phone());
    await stageAppPairing(db, {
      teamId: team.id,
      teamSlug: team.slug,
      pairingId: pairing.id,
      sealed,
      keys: daemon,
      appId: APP_ID,
      now: NOW,
      attestRoots: [root],
    });
    await expect(
      confirmPairing(db, {
        teamId: team.id,
        memberId: nick.id,
        actor: 'nick',
        pairingId: pairing.id,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: 'app_pairing' });
  });

  describe('a pairing that ended (ADR 802)', () => {
    async function bind(
      db: Driver,
      teamId: string,
      memberId: string,
      over: { created_at?: number; status?: string; daemon?: string; deviceKeyId?: string } = {},
    ) {
      const id = `b-${Math.random().toString(36).slice(2)}`;
      const keys = {
        signing_public_key: 's',
        receive_public_key: 'r',
        attest_key_id: 'a',
        environment: 'production',
        ...(over.daemon ? { daemon_identity_public_key: over.daemon } : {}),
        ...(over.deviceKeyId ? { device_key_id: over.deviceKeyId } : {}),
      };
      await db.run(
        `INSERT INTO channel_bindings
           (id, team_id, member_id, channel, provider_tenant_id, provider_user_id, generation,
            status, created_at, revoked_at, app_keys)
         VALUES (?, ?, ?, 'app', ?, ?, 1, ?, ?, NULL, ?)`,
        [
          id,
          teamId,
          memberId,
          `t-${id}`,
          `u-${id}`,
          over.status ?? 'active',
          over.created_at ?? NOW,
          JSON.stringify(keys),
        ],
      );
      return id;
    }
    const recorded = async (db: Driver, id: string) =>
      (await db.get<{ app_keys: string }>('SELECT app_keys FROM channel_bindings WHERE id = ?', [
        id,
      ]))!.app_keys;

    it("current when the pinned key is the daemon's; superseded after a rotation; revoked when revoked", async () => {
      const { db, team, nick } = await setup();
      const same = await bind(db, team.id, nick.id, { daemon: 'K1' });
      const old = await bind(db, team.id, nick.id, { daemon: 'K0' });
      const gone = await bind(db, team.id, nick.id, { daemon: 'K1', status: 'revoked' });
      await expect(appBindingEnded(db, team.id, same, { current: 'K1' })).resolves.toBeNull();
      await expect(appBindingEnded(db, team.id, old, { current: 'K1' })).resolves.toBe(
        'superseded',
      );
      await expect(appBindingEnded(db, team.id, gone, { current: 'K1' })).resolves.toBe('revoked');
      await expect(appBindingEnded(db, team.id, 'nope', { current: 'K1' })).resolves.toBeNull();
    });

    // Lane 01M6Q1RDTK: a pairing's phone key dies with the pairing. Measured 2026-11-05: nick had
    // one phone paired and three active phone keys, one per pairing round, every one still
    // standing authority. The sweep revokes the keys of superseded and revoked pairings only.
    it('revokes the phone keys of ended pairings, keeps the live one, and is idempotent', async () => {
      const { db, team, nick } = await setup();
      const phoneKey = async (n: string) =>
        (
          await enrollDeviceKey(db, {
            teamId: team.id,
            memberId: nick.id,
            publicKey: `pk-${n}`,
            kind: 'phone',
          })
        ).id;
      const kSame = await phoneKey('same');
      const kOld = await phoneKey('old');
      const kGone = await phoneKey('gone');
      const same = await bind(db, team.id, nick.id, { daemon: 'K1', deviceKeyId: kSame });
      const old = await bind(db, team.id, nick.id, { daemon: 'K0', deviceKeyId: kOld });
      const gone = await bind(db, team.id, nick.id, {
        daemon: 'K1',
        status: 'revoked',
        deviceKeyId: kGone,
      });
      const swept = await revokePhoneKeysOfEndedBindings(db, {
        teamId: team.id,
        member: { id: nick.id, name: 'nick' },
        current: 'K1',
      });
      expect(swept.map((r) => [r.keyId, r.binding, r.ended]).sort()).toEqual(
        [
          [kOld, old, 'superseded'],
          [kGone, gone, 'revoked'],
        ].sort(),
      );
      expect((await getDeviceKey(db, team.id, kSame))?.revokedAt).toBeNull();
      expect((await getDeviceKey(db, team.id, kOld))?.revokedAt).not.toBeNull();
      expect((await getDeviceKey(db, team.id, kGone))?.revokedAt).not.toBeNull();
      const via = (a: { detail: unknown }) =>
        (typeof a.detail === 'string'
          ? (JSON.parse(a.detail) as { via: string })
          : (a.detail as { via: string })
        ).via;
      const audited = await listAuditByAction(db, team.id, 'device_key.revoked', 100);
      expect(audited.map(via).sort()).toEqual(['binding_revoked', 'binding_superseded']);
      // Nothing left to sweep: a second pass revokes nothing and audits nothing more.
      await expect(
        revokePhoneKeysOfEndedBindings(db, {
          teamId: team.id,
          member: { id: nick.id, name: 'nick' },
          current: 'K1',
        }),
      ).resolves.toEqual([]);
      expect((await listAuditByAction(db, team.id, 'device_key.revoked', 100)).length).toBe(2);
      void same;
    });

    it('a phone key is over when its pairing is superseded or revoked, live while it stands, unpaired with no binding', async () => {
      const { db, team, nick } = await setup();
      const mk = async (n: string) =>
        (
          await enrollDeviceKey(db, {
            teamId: team.id,
            memberId: nick.id,
            publicKey: `pk-${n}`,
            kind: 'phone',
          })
        ).id;
      const kSame = await mk('same');
      const kOld = await mk('old');
      const kGone = await mk('gone');
      const kNone = await mk('none');
      await bind(db, team.id, nick.id, { daemon: 'K1', deviceKeyId: kSame });
      await bind(db, team.id, nick.id, { daemon: 'K0', deviceKeyId: kOld });
      await bind(db, team.id, nick.id, { daemon: 'K1', status: 'revoked', deviceKeyId: kGone });
      await expect(phoneKeyPairingEnded(db, team.id, kSame, { current: 'K1' })).resolves.toBeNull();
      await expect(phoneKeyPairingEnded(db, team.id, kOld, { current: 'K1' })).resolves.toBe(
        'superseded',
      );
      await expect(phoneKeyPairingEnded(db, team.id, kGone, { current: 'K1' })).resolves.toBe(
        'revoked',
      );
      await expect(phoneKeyPairingEnded(db, team.id, kNone, { current: 'K1' })).resolves.toBe(
        'unpaired',
      );
    });

    it('revoking a pairing revokes its phone key in the same transaction', async () => {
      const { db, team, nick } = await setup();
      const k = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: nick.id,
          publicKey: 'pk-r',
          kind: 'phone',
        })
      ).id;
      const b = await bind(db, team.id, nick.id, { daemon: 'K1', deviceKeyId: k });
      const r = await revokeBinding(db, {
        teamId: team.id,
        memberId: nick.id,
        actor: 'nick',
        bindingId: b,
      });
      expect(r.ok).toBe(true);
      expect((await getDeviceKey(db, team.id, k))?.revokedAt).not.toBeNull();
      const audited = await listAuditByAction(db, team.id, 'device_key.revoked', 100);
      expect(audited.length).toBe(1);
      expect(JSON.parse(audited[0]!.detail as string)).toMatchObject({
        key_id: k,
        via: 'binding_revoked',
        binding: b,
      });
    });

    it('the kill switch revokes every pairing and its phone key in one transaction', async () => {
      const { db, team, nick } = await setup();
      const k1 = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: nick.id,
          publicKey: 'pk-1',
          kind: 'phone',
        })
      ).id;
      const k2 = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: nick.id,
          publicKey: 'pk-2',
          kind: 'phone',
        })
      ).id;
      await bind(db, team.id, nick.id, { daemon: 'K1', deviceKeyId: k1 });
      await bind(db, team.id, nick.id, { daemon: 'K1', deviceKeyId: k2 });
      const r = await killSwitchChannels(db, { teamId: team.id, memberId: nick.id, actor: 'nick' });
      expect(r.bindingsRevoked).toBe(2);
      expect((await getDeviceKey(db, team.id, k1))?.revokedAt).not.toBeNull();
      expect((await getDeviceKey(db, team.id, k2))?.revokedAt).not.toBeNull();
      expect((await listAuditByAction(db, team.id, 'device_key.revoked', 100)).length).toBe(2);
    });

    // The recovery guard and the countersigner search read activeDeviceKeys, so a superseded
    // pairing's phone key is not a "usable key" for them either — before any sweep has run.
    it("a superseded pairing's phone key is not among the active keys, unswept", async () => {
      const { db, team, nick, daemon } = await setup();
      const kOld = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: nick.id,
          publicKey: 'pk-o',
          kind: 'phone',
        })
      ).id;
      const kNew = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: nick.id,
          publicKey: 'pk-n',
          kind: 'phone',
        })
      ).id;
      await bind(db, team.id, nick.id, { daemon: 'K0', deviceKeyId: kOld });
      await bind(db, team.id, nick.id, { daemon: daemon.identityPublic, deviceKeyId: kNew });
      const ids = (await activeDeviceKeys(db, team.id, nick.id)).map((k) => k.id);
      expect(ids).toEqual([kNew]);
      expect((await getDeviceKey(db, team.id, kOld))?.revokedAt).toBeNull();
    });

    it('the boot sweep covers every member and reports what it revoked', async () => {
      const { db, team, nick } = await setup();
      const ada = (await addMember(db, team, { name: 'Ada', kind: 'human' })).row;
      const kN = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: nick.id,
          publicKey: 'pk-n',
          kind: 'phone',
        })
      ).id;
      const kA = (
        await enrollDeviceKey(db, {
          teamId: team.id,
          memberId: ada.id,
          publicKey: 'pk-a',
          kind: 'phone',
        })
      ).id;
      await bind(db, team.id, nick.id, { daemon: 'K1', status: 'revoked', deviceKeyId: kN });
      await bind(db, team.id, ada.id, { daemon: 'K1', status: 'revoked', deviceKeyId: kA });
      await expect(revokePhoneKeysOfEndedBindingsEverywhere(db)).resolves.toEqual({
        members: 2,
        keys: 2,
      });
      await expect(revokePhoneKeysOfEndedBindingsEverywhere(db)).resolves.toEqual({
        members: 2,
        keys: 0,
      });
    });

    it('backfills an old row once: current if paired after the key file, else unknown (superseded)', async () => {
      const { db, team, nick } = await setup();
      const after = await bind(db, team.id, nick.id, { created_at: NOW + 10 });
      const before = await bind(db, team.id, nick.id, { created_at: NOW - 10 });
      await expect(
        appBindingEnded(db, team.id, after, { current: 'K1', keyBornAt: NOW }),
      ).resolves.toBeNull();
      await expect(
        appBindingEnded(db, team.id, before, { current: 'K1', keyBornAt: NOW }),
      ).resolves.toBe('superseded');
      expect(JSON.parse(await recorded(db, after)).daemon_identity_public_key).toBe('K1');
      expect(JSON.parse(await recorded(db, before)).daemon_identity_public_key).toBe(
        UNKNOWN_DAEMON_KEY,
      );
      // The verdict sticks: a later key-file time (a copy, a touch) cannot flip it.
      await expect(
        appBindingEnded(db, team.id, after, { current: 'K1', keyBornAt: NOW + 100 }),
      ).resolves.toBeNull();
      await expect(
        appBindingEnded(db, team.id, before, { current: 'K1', keyBornAt: 0 }),
      ).resolves.toBe('superseded');
      // A real rotation still supersedes the backfilled current key.
      await expect(appBindingEnded(db, team.id, after, { current: 'K2' })).resolves.toBe(
        'superseded',
      );
    });
  });
});
