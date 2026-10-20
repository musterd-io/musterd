import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  appAnswerSigningBytes,
  AppDeliverySchema,
  descriptorSigningBytes,
  makeEnvelope,
  type AppDelivery,
  type ApprovalDescriptor,
  type Envelope,
  type RelayAppDeliverFrame,
  type RelayDaemonFrame,
} from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appPairingChallenge } from '../store/appAttest.js';
import { fakeAppAttest } from '../store/appAttest.testkit.js';
import {
  appEnrollPayload,
  confirmAppPairing,
  stageAppPairing,
  stagedAppKeys,
  startAppPairing,
} from '../store/appPairing.js';
import { listAuditByAction } from '../store/audit.js';
import { buildDescriptor, enrollDeviceKey, revokeDeviceKey } from '../store/authority.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { setChannelSettings } from '../store/channelSettings.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { createTeam } from '../store/teams.js';
import {
  appDeliveryNonce,
  deliverAskToAppChannels,
  handleAppFetch,
  sendAppPaired,
} from './appAdapter.js';
import {
  __setAppChannelKeysForTest,
  generateAppChannelKeys,
  generatePhoneReceiveKey,
  openAsPhone,
  sealToDaemon,
  type AppChannelKeys,
} from './appSeal.js';
import { __setRelayLinkForTest, handleRelayCallback } from './relay.js';

const NOW = 1_800_000_000_000;
const APP_ID = 'D27MJGWNY3.io.musterd.app';
const PUSH_TOKEN = 'ab'.repeat(32);
let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

interface Phone {
  signing: KeyObject;
  receive: Awaited<ReturnType<typeof generatePhoneReceiveKey>>;
}

/** A team with nick paired to a phone through the real pairing path, and a captured relay link. */
async function seed(opts: { pushToken?: string | null } = {}) {
  const pushToken = opts.pushToken === undefined ? PUSH_TOKEN : opts.pushToken;
  const db = await openStore();
  const ctx = stubCtx(db);
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'ada', kind: 'agent', role: '' })).row;
  const daemon: AppChannelKeys = await generateAppChannelKeys();
  __setAppChannelKeysForTest(daemon);
  const sent: RelayDaemonFrame[] = [];
  __setRelayLinkForTest(ctx, team.slug, {
    send: (f) => {
      sent.push(f);
      return true;
    },
    stop: () => undefined,
  });

  // Pair: QR → sealed attested request → standing key approves.
  const standing = generateKeyPairSync('ed25519');
  const key1 = await enrollDeviceKey(db, {
    teamId: team.id,
    memberId: nick.id,
    publicKey: standing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
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
    now: NOW,
  });
  const sealedPair = await sealToDaemon({
    daemonReceivePublic: daemon.receivePublic,
    route: { team: team.slug, binding: 'pairing', ref: pairing.id, expires_at: qr.expires_at },
    payload: new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        code: qr.code,
        signing_public_key: signingRaw.toString('base64url'),
        receive_public_key: receive.publicRaw,
        attest_key_id: f.keyId.toString('base64url'),
        attestation: f.attestation.toString('base64url'),
        ...(pushToken ? { push_token: pushToken, push_environment: 'development' } : {}),
      }),
    ),
    purpose: 'pair',
  });
  const staged = await stageAppPairing(db, {
    teamId: team.id,
    teamSlug: team.slug,
    pairingId: pairing.id,
    sealed: sealedPair,
    keys: daemon,
    appId: APP_ID,
    now: NOW,
    attestRoots: [f.root],
  });
  if (!staged.ok) throw new Error(staged.reason);
  const d = await buildDescriptor(db, {
    teamId: team.id,
    audience: team.slug,
    memberId: nick.id,
    actor: 'nick',
    act: 'device_key_admin',
    target: 'nick',
    payload: appEnrollPayload((await stagedAppKeys(db, team.id, pairing.id))!),
    now: NOW,
  });
  const confirmed = await confirmAppPairing(db, {
    teamId: team.id,
    audience: team.slug,
    member: nick,
    pairingId: pairing.id,
    proof: {
      key_id: key1.id,
      nonce: d.nonce,
      signature: cryptoSign(
        null,
        Buffer.from(descriptorSigningBytes(d as ApprovalDescriptor), 'utf8'),
        standing.privateKey,
      ).toString('base64url'),
    },
    now: NOW,
  });
  if (!confirmed.ok) throw new Error(confirmed.reason);
  await setChannelSettings(db, {
    teamId: team.id,
    memberId: nick.id,
    actor: 'nick',
    settings: {
      channel: 'app',
      deliver: true,
      answer: true,
      presenceGating: false,
      tierFloor: null,
    },
  });
  const phone: Phone = { signing: signing.privateKey, receive };
  return {
    db,
    ctx,
    team,
    nick,
    ada,
    daemon,
    sent,
    phone,
    binding: confirmed.binding,
    deviceKeyId: confirmed.deviceKeyId,
    pairingId: pairing.id,
  };
}

async function raiseAsk(
  db: Driver,
  team: { id: string; slug: string },
  from: { id: string },
  to: { id: string },
  id: string,
  species = 'consult',
): Promise<Envelope> {
  const env = makeEnvelope({
    id,
    team: team.slug,
    from: 'ada',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    body: `ship ${id}?`,
    meta: { species, tier: 'standard' },
    ts: NOW,
  });
  await insertMessage(db, team.id, from.id, to.id, env);
  return env;
}

/** What the phone does with a captured frame: open, verify, parse. */
async function receive(s: Awaited<ReturnType<typeof seed>>, frame: RelayAppDeliverFrame) {
  const bytes = await openAsPhone({
    phoneReceivePrivate: s.phone.receive.privateKey,
    pinnedIdentityPublic: s.daemon.identityPublic,
    route: {
      team: s.team.slug,
      binding: frame.binding,
      ref: frame.ask_ref,
      expires_at: frame.expires_at,
    },
    sealed: frame.sealed,
  });
  return AppDeliverySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** The phone's answer callback body, signed by `signer` (the phone's key unless a test swaps it). */
async function answerBody(
  s: Awaited<ReturnType<typeof seed>>,
  delivery: Extract<AppDelivery, { kind: 'ask' }>,
  over: {
    decision?: 'approve' | 'reject';
    reported?: boolean;
    signer?: KeyObject;
    nonce?: string;
    ref?: string;
    sealRef?: string;
  } = {},
) {
  const decision = over.decision ?? 'approve';
  const reported = over.reported ?? false;
  const nonce = over.nonce ?? delivery.nonce;
  const ref = over.ref ?? delivery.ask.id;
  const signature = cryptoSign(
    'sha256',
    Buffer.from(
      appAnswerSigningBytes({
        team: s.team.slug,
        binding: s.binding.id,
        ask: ref,
        token: delivery.token,
        decision,
        nonce,
        reported,
      }),
      'utf8',
    ),
    over.signer ?? s.phone.signing,
  ).toString('base64url');
  const route = {
    team: s.team.slug,
    binding: s.binding.id,
    ref: over.sealRef ?? ref,
    expires_at: delivery.expires_at,
  };
  const sealed = await sealToDaemon({
    daemonReceivePublic: s.daemon.receivePublic,
    route,
    payload: new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        token: delivery.token,
        decision,
        nonce,
        signature,
        ...(reported ? { reported } : {}),
      }),
    ),
    purpose: 'answer',
  });
  return JSON.stringify({
    app: 1,
    kind: 'answer',
    binding: s.binding.id,
    ref,
    expires_at: delivery.expires_at,
    sealed,
  });
}

const callback = (askRef: string, body: string) =>
  ({ protocol: 1, type: 'callback', ask_ref: askRef, body }) as const;

function lastAppFrame(sent: RelayDaemonFrame[]): RelayAppDeliverFrame {
  const f = [...sent].reverse().find((x) => x.type === 'app_deliver');
  if (!f || f.type !== 'app_deliver') throw new Error('no app_deliver frame');
  return f;
}

withDrivers('app channel adapter (ADR 676 §2, §6–§8)', (o) => {
  beforeEach(() => {
    openStore = o;
  });
  afterEach(() => __setAppChannelKeysForTest(null));

  it('an advisory ask reaches the phone sealed and signed, and its signed answer redeems once', async () => {
    const s = await seed();
    const env = await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-1');
    await deliverAskToAppChannels(s.ctx, s.team, env);
    const frame = lastAppFrame(s.sent);
    expect(frame).toMatchObject({ ask_ref: 'ask-1', binding: s.binding.id });
    expect(JSON.stringify(frame)).not.toContain('ship ask-1');

    const delivery = await receive(s, frame);
    if (delivery.kind !== 'ask') throw new Error('expected an ask');
    expect(delivery.ask).toMatchObject({
      id: 'ask-1',
      from: 'ada',
      from_kind: 'agent',
      body: 'ship ask-1?',
    });
    expect(delivery.nonce).toBe(appDeliveryNonce(delivery.token));

    const body = await answerBody(s, delivery);
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-1', body), NOW + 1_000),
    ).resolves.toEqual({
      ok: true,
    });
    const answer = await s.db.get<{ meta: string }>(
      "SELECT meta FROM messages WHERE team_id = ? AND id LIKE 'app-ask-1-%'",
      [s.team.id],
    );
    expect(JSON.parse(answer!.meta)).toMatchObject({
      in_reply_to: 'ask-1',
      channel_answer: { channel: 'app', decision: 'approve', signed_by: s.deviceKeyId },
    });
    // The same answer again: the token is spent.
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-1', body), NOW + 2_000),
    ).resolves.toEqual({
      ok: false,
      reason: 'consumed',
    });

    const delivered = await listAuditByAction(s.db, s.team.id, 'channel.sealed_delivered', 10);
    expect(delivered.some((r) => r.target === 'ask-1')).toBe(true);
    expect(JSON.stringify(delivered)).not.toContain(delivery.token);
  });

  it('a privileged ask is not delivered to the app in this increment', async () => {
    const s = await seed();
    const env = await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-p', 'approve');
    await deliverAskToAppChannels(s.ctx, s.team, env);
    expect(s.sent.filter((f) => f.type === 'app_deliver')).toHaveLength(0);
  });

  it('"I did not expect this" on a reject writes channel.answer_reported naming the asking seat', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-2'),
    );
    const delivery = await receive(s, lastAppFrame(s.sent));
    if (delivery.kind !== 'ask') throw new Error('expected an ask');
    const body = await answerBody(s, delivery, { decision: 'reject', reported: true });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-2', body), NOW + 1_000),
    ).resolves.toEqual({
      ok: true,
    });
    const rows = await listAuditByAction(s.db, s.team.id, 'channel.answer_reported', 10);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
      asking_seat: 'ada',
      binding_id: s.binding.id,
    });
  });

  it('each delivery names the binding’s push target; a binding paired without one is not pushed', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-p'),
    );
    expect(lastAppFrame(s.sent).push).toEqual({ token: PUSH_TOKEN, environment: 'development' });

    const bare = await seed({ pushToken: null });
    await deliverAskToAppChannels(
      bare.ctx,
      bare.team,
      await raiseAsk(bare.db, bare.team, bare.ada, bare.nick, 'ask-q'),
    );
    expect(bare.sent.filter((f) => f.type === 'app_deliver')).toHaveLength(0);
    const rows = await listAuditByAction(bare.db, bare.team.id, 'channel.sealed_delivered', 100);
    expect(rows.find((r) => r.target === 'ask-q')).toMatchObject({ result: 'deny' });
    expect(JSON.stringify(rows.find((r) => r.target === 'ask-q'))).toContain('no_push_token');
  });

  it('a body fetch re-issues that one ask under a fresh token, and answers null for anything not live', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-f'),
    );
    const pushed = lastAppFrame(s.sent);
    const first = await receive(s, pushed);
    const fetched = await handleAppFetch(
      s.ctx,
      s.team,
      { ask_ref: 'ask-f', binding: s.binding.id },
      NOW + 1_000,
    );
    if (!fetched) throw new Error('expected a body');
    expect(fetched.expires_at).toBe(pushed.expires_at);
    const second = await receive(s, { ...pushed, sealed: fetched.sealed });
    if (first.kind !== 'ask' || second.kind !== 'ask') throw new Error('expected asks');
    expect(second.ask.body).toBe('ship ask-f?');
    expect(second.token).not.toBe(first.token);
    // Nothing went to the relay for a fetch: the body travels back on the fetch alone.
    expect(s.sent.filter((f) => f.type === 'app_deliver')).toHaveLength(1);
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-f', await answerBody(s, first)),
        NOW + 2_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'consumed' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-f', await answerBody(s, second)),
        NOW + 2_000,
      ),
    ).resolves.toEqual({ ok: true });
    // Decided now, so nothing is live for it; nor for an unknown ask or binding.
    await expect(
      handleAppFetch(s.ctx, s.team, { ask_ref: 'ask-f', binding: s.binding.id }, NOW + 3_000),
    ).resolves.toBeNull();
    await expect(
      handleAppFetch(s.ctx, s.team, { ask_ref: 'nope', binding: s.binding.id }, NOW + 3_000),
    ).resolves.toBeNull();
    await expect(
      handleAppFetch(s.ctx, s.team, { ask_ref: 'ask-f', binding: 'nope' }, NOW + 3_000),
    ).resolves.toBeNull();
    const rows = await listAuditByAction(s.db, s.team.id, 'channel.sealed_delivered', 100);
    expect(rows.some((r) => r.target === 'ask-f' && JSON.stringify(r).includes('fetched'))).toBe(
      true,
    );
  });

  it('redeliver re-sends a pending ask with a fresh token and spends the old one', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-3'),
    );
    const first = await receive(s, lastAppFrame(s.sent));
    const redeliver = JSON.stringify({ app: 1, kind: 'redeliver', binding: s.binding.id });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('redeliver', redeliver), NOW + 1_000),
    ).resolves.toEqual({ ok: true });
    const second = await receive(s, lastAppFrame(s.sent));
    if (first.kind !== 'ask' || second.kind !== 'ask') throw new Error('expected asks');
    expect(second.ask.id).toBe('ask-3');
    expect(second.token).not.toBe(first.token);
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-3', await answerBody(s, first)),
        NOW + 2_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'consumed' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-3', await answerBody(s, second)),
        NOW + 2_000,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('the paired delivery is signed and names the device key', async () => {
    const s = await seed();
    await sendAppPaired(s.ctx, s.team, {
      binding: s.binding as ChannelBinding,
      member: 'nick',
      deviceKeyId: s.deviceKeyId,
      pairingId: s.pairingId,
    });
    const paired = await receive(s, lastAppFrame(s.sent));
    expect(paired).toMatchObject({ kind: 'paired', member: 'nick', device_key_id: s.deviceKeyId });
  });

  // ── a malicious relay (ADR 676 Eval) ──

  it('an answer sealed for one ask and presented as another does not open', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-a'),
    );
    const a = await receive(s, lastAppFrame(s.sent));
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-b'),
    );
    if (a.kind !== 'ask') throw new Error('expected an ask');
    // Sealed under ask-a's route, relabelled as ask-b.
    const swapped = await answerBody(s, a, { ref: 'ask-b', sealRef: 'ask-a' });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-b', swapped), NOW + 1_000),
    ).resolves.toEqual({
      ok: false,
      reason: 'sealed_body',
    });
  });

  it('a stripped seal (plaintext answer) is not an app callback at all', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-c'),
    );
    const c = await receive(s, lastAppFrame(s.sent));
    if (c.kind !== 'ask') throw new Error('expected an ask');
    const plaintext = JSON.stringify({
      app: 1,
      kind: 'answer',
      binding: s.binding.id,
      ref: 'ask-c',
      expires_at: c.expires_at,
      answer: { token: c.token, decision: 'approve' },
    });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-c', plaintext), NOW + 1_000),
    ).resolves.toEqual({
      ok: false,
      reason: 'unparseable_callback',
    });
  });

  it('an answer signed by any key but the enrolled phone key, or with a wrong nonce, is refused', async () => {
    const s = await seed();
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-d'),
    );
    const dlv = await receive(s, lastAppFrame(s.sent));
    if (dlv.kind !== 'ask') throw new Error('expected an ask');
    const impostor = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-d', await answerBody(s, dlv, { signer: impostor })),
        NOW + 1,
      ),
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-d', await answerBody(s, dlv, { nonce: 'x'.repeat(22) })),
        NOW + 1,
      ),
    ).resolves.toEqual({ ok: false, reason: 'nonce_mismatch' });
    // The binding's phone key revoked (lost phone): nothing it signed redeems any more.
    await revokeDeviceKey(s.db, s.team.id, s.deviceKeyId);
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-d', await answerBody(s, dlv)), NOW + 1),
    ).resolves.toEqual({ ok: false, reason: 'key_revoked' });
  });
});
