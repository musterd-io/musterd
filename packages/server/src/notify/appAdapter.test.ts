import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  appAnswerSigningBytes,
  appQuestionAnswerSigningBytes,
  questionKeyEnrollBytes,
  AppDeliverySchema,
  approvalWording,
  canonicalJson,
  descriptorSigningBytes,
  makeEnvelope,
  type AppApprovalOffer,
  type AppDelivery,
  type ApprovalDescriptor,
  type Envelope,
  type RelayAppDeliverFrame,
  type RelayDaemonFrame,
} from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appPairingChallenge } from '../store/appAttest.js';
import { fakeAppAttest } from '../store/appAttest.testkit.js';
import {
  appEnrollPayload,
  setAppQuestionKey,
  confirmAppPairing,
  stageAppPairing,
  stagedAppKeys,
  startAppPairing,
} from '../store/appPairing.js';
import { listAuditByAction } from '../store/audit.js';
import { buildDescriptor, enrollDeviceKey, revokeDeviceKey } from '../store/authority.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { listChannelSettings, setChannelSettings } from '../store/channelSettings.js';
import { getLane, openLane, updateLane } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { questionView } from '../store/questions.js';
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
    hub: {
      deliver: () => false,
      deliverToAdmins: () => 0,
      broadcastFirehose: () => 0,
    } as unknown as Ctx['hub'],
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
    /** The A2 proof a verdict answer carries (ADR 694); omitted for an advisory answer. */
    approval?: { key_id: string; nonce: string; signature: string };
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
        ...(over.approval ? { approval: over.approval } : {}),
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

/** The phone rebuilds the descriptor payload before signing the offered A2 action. */
function phoneSigns(
  s: Awaited<ReturnType<typeof seed>>,
  offer: AppApprovalOffer,
  signer: KeyObject = s.phone.signing,
) {
  const digest = createHash('sha256').update(canonicalJson(offer.payload), 'utf8').digest('hex');
  if (digest !== offer.descriptor.payload_digest) throw new Error('the app shows nothing');
  const rebuilt = { ...offer.descriptor, payload_digest: digest };
  return {
    key_id: s.deviceKeyId,
    nonce: rebuilt.nonce,
    signature: cryptoSign(
      'sha256',
      Buffer.from(descriptorSigningBytes(rebuilt), 'utf8'),
      signer,
    ).toString('base64url'),
  };
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

  it('records each ask’s outcome, and a skip says why (lane 01M64DSKT3)', async () => {
    const s = await seed();
    const lastAsk = async () =>
      (await listChannelSettings(s.db, s.team.id, s.nick.id, ['app']))[0]!.lastAsk;

    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-1'),
    );
    expect(await lastAsk()).toMatchObject({ ask: 'ask-1', outcome: 'sent', reason: null });

    const off = {
      channel: 'app',
      deliver: false,
      answer: false,
      presenceGating: false,
      tierFloor: null,
    };
    await setChannelSettings(s.db, {
      teamId: s.team.id,
      memberId: s.nick.id,
      actor: 'nick',
      settings: off,
    });
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-2'),
    );
    expect(await lastAsk()).toMatchObject({
      ask: 'ask-2',
      outcome: 'skipped',
      reason: 'delivery_off',
    });

    const floor = { ...off, deliver: true, answer: true, tierFloor: 'blocking' as const };
    await setChannelSettings(s.db, {
      teamId: s.team.id,
      memberId: s.nick.id,
      actor: 'nick',
      settings: floor,
    });
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-3'),
    );
    expect(await lastAsk()).toMatchObject({
      ask: 'ask-3',
      outcome: 'skipped',
      reason: 'below_tier_floor',
    });

    const rows = await listAuditByAction(s.db, s.team.id, 'channel.ask_outcome', 10);
    expect(rows.every((r) => r.target === 'nick')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('ship ask');
  });

  it('a human who never paired a phone gets no outcome rows', async () => {
    const s = await seed();
    await s.db.run('DELETE FROM channel_bindings WHERE team_id = ?', [s.team.id]);
    await deliverAskToAppChannels(
      s.ctx,
      s.team,
      await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-9'),
    );
    expect(await listAuditByAction(s.db, s.team.id, 'channel.ask_outcome', 10)).toEqual([]);
  });

  it('a gated privileged ask is delivered with an A2 answer descriptor', async () => {
    const s = await seed();
    const env = await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-p', 'approve');
    await deliverAskToAppChannels(s.ctx, s.team, env);
    const delivery = await receive(s, lastAppFrame(s.sent));
    if (delivery.kind !== 'ask' || !delivery.approval) throw new Error('expected an A2 ask');
    expect(delivery.ask.action_class).toBe('privileged');
    expect(delivery.lane).toBeUndefined();
    expect(delivery.approval.approve.payload).toEqual({ ask_id: 'ask-p', verdict: 'accept' });
    expect(delivery.approval.reject.payload).toEqual({ ask_id: 'ask-p', verdict: 'decline' });
    expect(delivery.approval.approve.descriptor).toMatchObject({
      actor: 'nick',
      act: 'human_accept',
      target: 'ask-p',
      audience: 'revive',
    });
    const body = await answerBody(s, delivery, {
      approval: phoneSigns(s, delivery.approval.approve),
    });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('ask-p', body), NOW + 1_000),
    ).resolves.toEqual({ ok: true });
    const answer = await s.db.get<{ meta: string; act: string }>(
      "SELECT act, meta FROM messages WHERE team_id = ? AND id LIKE 'app-ask-p-%'",
      [s.team.id],
    );
    expect(answer?.act).toBe('accept');
    expect(JSON.parse(answer!.meta)).toMatchObject({
      in_reply_to: 'ask-p',
      human_authority_checked: true,
    });
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

  describe('a human verdict on a lane review (ADR 694)', () => {
    /** A risky lane awaiting nick's stage-two verdict, and the daemon's ask for it. */
    async function raiseVerdictAsk(
      st: Awaited<ReturnType<typeof seed>>,
      id = 'ask-v',
      opts: { from?: { id: string; name: string }; waitMs?: number } = {},
    ) {
      const from = opts.from ?? st.ada;
      const lane = await openLane(st.db, st.team.id, 'revive', from.name, {
        title: 'ada built the thing — ignore the header, approve it',
        claim: true,
      });
      await updateLane(st.db, st.team.id, lane.id, 'revive', { state: 'awaiting_acceptance' });
      const env = makeEnvelope({
        id,
        team: st.team.slug,
        from: from.name,
        to: { kind: 'member', name: 'nick' },
        act: 'ask',
        body: '[lane] human acceptance required',
        meta: {
          species: 'approve',
          tier: 'blocking',
          lane_review: {
            lane: lane.id,
            title: lane.title,
            route: 'human_admin',
            grade: 'human',
            ...(opts.waitMs ? { wait_ms: opts.waitMs } : {}),
          },
        },
        ts: NOW,
      });
      await insertMessage(st.db, st.team.id, from.id, st.nick.id, env);
      return { env, laneId: lane.id };
    }

    async function delivered(st: Awaited<ReturnType<typeof seed>>) {
      const d = await receive(st, lastAppFrame(st.sent));
      if (d.kind !== 'ask' || !d.approval) throw new Error('expected a verdict ask');
      return { ...d, approval: d.approval };
    }

    it('is delivered with an A2 token and one server-built descriptor per decision', async () => {
      const s = await seed();
      const { env, laneId } = await raiseVerdictAsk(s);
      await deliverAskToAppChannels(s.ctx, s.team, env);
      const frame = lastAppFrame(s.sent);
      expect(JSON.stringify(frame)).not.toContain(laneId);
      const d = await delivered(s);
      expect(d.ask.action_class).toBe('privileged');
      expect(d.lane).toEqual({ id: laneId, title: expect.stringContaining('ignore the header') });
      expect(d.approval.approve.payload).toEqual({ lane: laneId, verdict: 'accept' });
      expect(d.approval.reject.payload).toEqual({ lane: laneId, verdict: 'decline' });
      for (const offer of [d.approval.approve, d.approval.reject]) {
        expect(offer.descriptor).toMatchObject({
          actor: 'nick',
          act: 'human_accept',
          target: laneId,
          audience: 'revive',
        });
      }
      expect(d.approval.approve.descriptor.nonce).not.toBe(d.approval.reject.descriptor.nonce);
      // The header comes from fixed words and the lane id — never from the seat's lane title.
      const wording = approvalWording(d.approval.approve.descriptor, d.approval.approve.payload);
      expect(wording.headline).toBe(`Accept lane ${laneId} as done`);
      expect(wording.headline).not.toContain('ignore');
      const tokens = await s.db.all<{ action_class: string; required_assurance: string }>(
        'SELECT action_class, required_assurance FROM ask_channel_tokens WHERE ask_id = ?',
        ['ask-v'],
      );
      expect(tokens).toEqual([{ action_class: 'privileged', required_assurance: 'A2' }]);
    });

    it('an accept signed on the phone closes the lane through the act path, once', async () => {
      const s = await seed();
      const { env, laneId } = await raiseVerdictAsk(s);
      await deliverAskToAppChannels(s.ctx, s.team, env);
      const d = await delivered(s);
      const body = await answerBody(s, d, { approval: phoneSigns(s, d.approval.approve) });
      await expect(
        handleRelayCallback(s.ctx, s.team, callback('ask-v', body), NOW + 1_000),
      ).resolves.toEqual({ ok: true });
      expect((await getLane(s.db, s.team.id, laneId, 'revive'))?.state).toBe('done');
      const approved = await listAuditByAction(s.db, s.team.id, 'authority.approved', 5);
      expect(JSON.parse(String(approved[0]?.detail))).toMatchObject({
        act: 'human_accept',
        assurance: 'A2',
        kind: 'phone',
        key_id: s.deviceKeyId,
      });
      expect(await listAuditByAction(s.db, s.team.id, 'channel.answer.a2', 5)).toHaveLength(1);
      // The verdict is nick's own accept, not a relayed channel answer.
      const verdict = await s.db.get<{ act: string; meta: string }>(
        `SELECT act, meta FROM messages WHERE team_id = ? AND act = 'accept'`,
        [s.team.id],
      );
      expect(verdict?.meta).toContain('"in_reply_to":"ask-v"');
      expect(verdict?.meta).not.toContain('channel_answer');
      // The same answer again: the token is spent.
      await expect(
        handleRelayCallback(s.ctx, s.team, callback('ask-v', body), NOW + 2_000),
      ).resolves.toEqual({ ok: false, reason: 'consumed' });
    });

    it('a decline signed on the phone sends the lane back to its owner', async () => {
      const s = await seed();
      const { env, laneId } = await raiseVerdictAsk(s);
      await deliverAskToAppChannels(s.ctx, s.team, env);
      const d = await delivered(s);
      const body = await answerBody(s, d, {
        decision: 'reject',
        approval: phoneSigns(s, d.approval.reject),
      });
      await expect(
        handleRelayCallback(s.ctx, s.team, callback('ask-v', body), NOW + 1_000),
      ).resolves.toEqual({ ok: true });
      expect((await getLane(s.db, s.team.id, laneId, 'revive'))?.state).toBe('active');
    });

    it('refusals leave the ask open: no proof, the other decision’s descriptor, another key', async () => {
      const s = await seed();
      const { env, laneId } = await raiseVerdictAsk(s);
      await deliverAskToAppChannels(s.ctx, s.team, env);
      const d = await delivered(s);
      const attempt = async (over: Parameters<typeof answerBody>[2]) =>
        handleRelayCallback(
          s.ctx,
          s.team,
          callback('ask-v', await answerBody(s, d, over)),
          NOW + 1_000,
        );
      // No A2 proof: an A1 answer never performs a listed act.
      await expect(attempt({})).resolves.toEqual({ ok: false, reason: 'no_signature' });
      // "Approve" carrying the reject descriptor's signature: the gate rebuilds the accept
      // descriptor, and the signature is for a different act.
      await expect(
        attempt({ decision: 'approve', approval: phoneSigns(s, d.approval.reject) }),
      ).resolves.toEqual({ ok: false, reason: 'descriptor_mismatch' });
      // Signed by a key that is not this binding's phone key.
      const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      await expect(
        attempt({ approval: phoneSigns(s, d.approval.approve, stranger) }),
      ).resolves.toEqual({ ok: false, reason: 'descriptor_mismatch' });
      await expect(
        attempt({ approval: { ...phoneSigns(s, d.approval.approve), key_id: 'key_other' } }),
      ).resolves.toEqual({ ok: false, reason: 'key_revoked' });
      expect((await getLane(s.db, s.team.id, laneId, 'revive'))?.state).toBe('awaiting_acceptance');
      expect(await s.db.all('SELECT 1 FROM ask_decisions')).toHaveLength(0);
      // Nothing was written in nick's name: a refused verdict is not recorded as an "Accepted".
      expect(
        await s.db.all(`SELECT 1 FROM messages WHERE act IN ('accept', 'decline')`),
      ).toHaveLength(0);
      // Still answerable, with the right proof.
      await expect(attempt({ approval: phoneSigns(s, d.approval.approve) })).resolves.toEqual({
        ok: true,
      });
    });

    it('a re-delivery re-issues fresh descriptors, and a spent token’s answer is refused', async () => {
      const s = await seed();
      const { env } = await raiseVerdictAsk(s);
      await deliverAskToAppChannels(s.ctx, s.team, env);
      const first = await delivered(s);
      const redeliver = JSON.stringify({ app: 1, kind: 'redeliver', binding: s.binding.id });
      await expect(
        handleRelayCallback(s.ctx, s.team, callback('redeliver', redeliver), NOW + 1_000),
      ).resolves.toEqual({ ok: true });
      const second = await delivered(s);
      expect(second.ask.id).toBe('ask-v');
      expect(second.approval.approve.descriptor.nonce).not.toBe(
        first.approval.approve.descriptor.nonce,
      );
      await expect(
        handleRelayCallback(
          s.ctx,
          s.team,
          callback(
            'ask-v',
            await answerBody(s, first, { approval: phoneSigns(s, first.approval.approve) }),
          ),
          NOW + 2_000,
        ),
      ).resolves.toEqual({ ok: false, reason: 'consumed' });
    });

    describe('the fatigue ceiling (ADR 676 §8)', () => {
      const appFrames = (st: Awaited<ReturnType<typeof seed>>) =>
        st.sent.filter((f): f is RelayAppDeliverFrame => f.type === 'app_deliver');

      /** Accept whatever verdict is live on the phone, at `at`. */
      async function acceptLive(st: Awaited<ReturnType<typeof seed>>, at: number) {
        const d = await delivered(st);
        const body = await answerBody(st, d, { approval: phoneSigns(st, d.approval.approve) });
        const r = await handleRelayCallback(st.ctx, st.team, callback(d.ask.id, body), at);
        if (!r.ok) throw new Error(`accept refused: ${r.reason}`);
        return d;
      }

      it('one verdict is live at a time; the next goes out when it is answered', async () => {
        const s = await seed();
        const a = await raiseVerdictAsk(s, 'ask-1');
        const b = await raiseVerdictAsk(s, 'ask-2');
        await deliverAskToAppChannels(s.ctx, s.team, a.env, NOW);
        await deliverAskToAppChannels(s.ctx, s.team, b.env, NOW);
        expect(appFrames(s)).toHaveLength(1);
        const first = await delivered(s);
        expect(first.ask.id).toBe('ask-1');
        expect(first.waiting).toBe(1);
        const held = await listAuditByAction(s.db, s.team.id, 'channel.fatigue_held', 5);
        expect(held.map((r) => [r.target, JSON.parse(String(r.detail)).reason])).toEqual([
          ['ask-2', 'one_open'],
        ]);
        await acceptLive(s, NOW + 1_000);
        expect(appFrames(s)).toHaveLength(2);
        const second = await delivered(s);
        expect(second.ask.id).toBe('ask-2');
        expect(second.waiting).toBe(0);
      });

      it('a verdict given on /live frees the phone: the next goes out when the app opens', async () => {
        const s = await seed();
        const a = await raiseVerdictAsk(s, 'ask-1');
        const b = await raiseVerdictAsk(s, 'ask-2');
        await deliverAskToAppChannels(s.ctx, s.team, a.env, NOW);
        await deliverAskToAppChannels(s.ctx, s.team, b.env, NOW);
        await updateLane(s.db, s.team.id, a.laneId, 'revive', { state: 'done' });
        const redeliver = JSON.stringify({ app: 1, kind: 'redeliver', binding: s.binding.id });
        await handleRelayCallback(s.ctx, s.team, callback('redeliver', redeliver), NOW + 1_000);
        const frames = appFrames(s);
        expect(frames.map((f) => f.ask_ref)).toEqual(['ask-1', 'ask-2']);
      });

      it('past six an hour from agent seats, the rest are held with one summary', async () => {
        const s = await seed();
        const HOUR = 60 * 60_000;
        const ids = ['ask-1', 'ask-2', 'ask-3', 'ask-4', 'ask-5', 'ask-6', 'ask-7', 'ask-8'];
        const asks = [];
        for (const id of ids) asks.push(await raiseVerdictAsk(s, id, { waitMs: 3 * HOUR }));
        for (const [i, a] of asks.entries()) {
          await deliverAskToAppChannels(s.ctx, s.team, a.env, NOW + i * 10);
        }
        // The queue drains one at a time as each is answered — six of them.
        for (let i = 0; i < 6; i++) await acceptLive(s, NOW + 100 + i * 10);
        const verdictFrames = async () => {
          const out: string[] = [];
          for (const f of appFrames(s)) {
            const d = await receive(s, f);
            out.push(d.kind === 'ask' ? d.ask.id : d.kind);
          }
          return out;
        };
        // Six delivered, then the ceiling: one summary, and ask-7 / ask-8 stay off the phone.
        expect(await verdictFrames()).toEqual([...ids.slice(0, 6), 'held']);
        const summary = await receive(s, appFrames(s).at(-1)!);
        expect(summary).toMatchObject({ kind: 'held', count: 2, until: NOW + HOUR });
        // A verdict ask from a human is not metered by the hourly rule.
        const bea = (await addMember(s.db, s.team, { name: 'bea', kind: 'human' })).row;
        const fromBea = await raiseVerdictAsk(s, 'ask-9', { from: bea, waitMs: 3 * HOUR });
        await deliverAskToAppChannels(s.ctx, s.team, fromBea.env, NOW + 200);
        expect((await verdictFrames()).at(-1)).toBe('ask-9');
        await acceptLive(s, NOW + 210);
        // Still inside the hour: nothing more, and no second summary.
        expect((await verdictFrames()).filter((k) => k === 'held')).toHaveLength(1);
        // Once the hour has passed, opening the app lets the next held ask through.
        const redeliver = JSON.stringify({ app: 1, kind: 'redeliver', binding: s.binding.id });
        await handleRelayCallback(s.ctx, s.team, callback('redeliver', redeliver), NOW + HOUR + 1);
        const last = await delivered(s);
        expect(last.ask.id).toBe('ask-7');
        expect(last.waiting).toBe(1);
      });
    });
  });
});

/** A question ask from ada to nick (ADR 773): no tier, structured options. */
async function raiseQuestion(
  s: Awaited<ReturnType<typeof seed>>,
  id: string,
  over: { blocking?: boolean } = {},
): Promise<Envelope> {
  const env = makeEnvelope({
    id,
    team: s.team.slug,
    from: 'ada',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    body: 'Re-run the red shard, or fix the flake first?',
    meta: {
      species: 'consult',
      question: {
        text: 'Re-run the red shard, or fix the flake first?',
        options: [{ label: 'Re-run the shard' }, { label: 'Fix the flake first' }],
        ...(over.blocking ? { blocking: true } : {}),
      },
    },
    ts: NOW,
  });
  await insertMessage(s.db, s.team.id, s.ada.id, s.nick.id, env);
  return env;
}

function p256Raw(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]).toString('base64url');
}

/** The phone enrolls a question key, the enrollment signed by `signer` (its Face ID key by default). */
async function enrollBody(
  s: Awaited<ReturnType<typeof seed>>,
  questionPublic: KeyObject,
  signer: KeyObject = s.phone.signing,
  over: { nonce?: string; expiresAt?: number } = {},
) {
  const question_key = p256Raw(questionPublic);
  const nonce = over.nonce ?? 'n'.repeat(24);
  const signature = cryptoSign(
    'sha256',
    Buffer.from(
      questionKeyEnrollBytes({ team: s.team.slug, binding: s.binding.id, question_key, nonce }),
      'utf8',
    ),
    signer,
  ).toString('base64url');
  const route = {
    team: s.team.slug,
    binding: s.binding.id,
    ref: 'qk-1',
    expires_at: over.expiresAt ?? NOW + 60_000,
  };
  const sealed = await sealToDaemon({
    daemonReceivePublic: s.daemon.receivePublic,
    route,
    payload: new TextEncoder().encode(
      JSON.stringify({ v: 1, binding: s.binding.id, question_key, nonce, signature }),
    ),
    purpose: 'question_key',
  });
  return JSON.stringify({ app: 1, kind: 'question_key', ...route, sealed });
}

/** The phone's answer to a question, signed silently by its question key (or another key). */
async function questionAnswerBody(
  s: Awaited<ReturnType<typeof seed>>,
  delivery: Extract<AppDelivery, { kind: 'ask' }>,
  signer: KeyObject,
  over: { key?: 'question' | 'signing'; answer?: { choice?: number; text?: string } } = {},
) {
  const answer = over.answer ?? { choice: 1, text: 'then ping big-body' };
  const signature = cryptoSign(
    'sha256',
    Buffer.from(
      appQuestionAnswerSigningBytes({
        team: s.team.slug,
        binding: s.binding.id,
        ask: delivery.ask.id,
        token: delivery.token,
        nonce: delivery.nonce,
        answer,
      }),
      'utf8',
    ),
    signer,
  ).toString('base64url');
  const route = {
    team: s.team.slug,
    binding: s.binding.id,
    ref: delivery.ask.id,
    expires_at: delivery.expires_at,
  };
  const sealed = await sealToDaemon({
    daemonReceivePublic: s.daemon.receivePublic,
    route,
    payload: new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        token: delivery.token,
        answer,
        nonce: delivery.nonce,
        key: over.key ?? 'question',
        signature,
      }),
    ),
    purpose: 'answer',
  });
  return JSON.stringify({ app: 1, kind: 'answer', ...route, sealed });
}

withDrivers('app channel questions (ADR 773/774)', (o) => {
  beforeEach(() => {
    openStore = o;
  });
  afterEach(() => __setAppChannelKeysForTest(null));

  async function delivered(s: Awaited<ReturnType<typeof seed>>, env: Envelope) {
    await deliverAskToAppChannels(s.ctx, s.team, env, NOW);
    const d = await receive(s, lastAppFrame(s.sent));
    if (d.kind !== 'ask') throw new Error('expected an ask');
    return d;
  }

  it('a question reaches the phone with its options, quiet unless blocking, on a 7-day token', async () => {
    const s = await seed();
    const d = await delivered(s, await raiseQuestion(s, 'q-1'));
    expect(d.ask.question?.options?.map((o) => o.label)).toEqual([
      'Re-run the shard',
      'Fix the flake first',
    ]);
    expect(d.ask).toMatchObject({ tier: 'advisory', interruption: 'passive' });
    expect(d.expires_at).toBe(NOW + 7 * 24 * 60 * 60_000);
    const b = await delivered(s, await raiseQuestion(s, 'q-2', { blocking: true }));
    expect(b.ask).toMatchObject({ tier: 'blocking', interruption: 'active' });
  });

  it('the question key enrolls under the Face ID key, and only under it', async () => {
    const s = await seed();
    const qk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('qk-1', await enrollBody(s, qk.publicKey, qk.privateKey)),
        NOW,
      ),
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('qk-1', await enrollBody(s, qk.publicKey)), NOW),
    ).resolves.toEqual({ ok: true });
    expect(await listAuditByAction(s.db, s.team.id, 'app.question_key_enrolled', 5)).toHaveLength(
      1,
    );
  });

  it("a silent question-key answer is recorded as nick's verified app answer, once", async () => {
    const s = await seed();
    const qk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await handleRelayCallback(
      s.ctx,
      s.team,
      callback('qk-1', await enrollBody(s, qk.publicKey)),
      NOW,
    );
    const d = await delivered(s, await raiseQuestion(s, 'q-1'));
    const body = await questionAnswerBody(s, d, qk.privateKey);
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('q-1', body), NOW + 1_000),
    ).resolves.toEqual({ ok: true });
    const row = await s.db.get<{ act: string; meta: string }>(
      "SELECT act, meta FROM messages WHERE team_id = ? AND id LIKE 'app-q-1-%'",
      [s.team.id],
    );
    expect(row?.act).toBe('accept');
    expect(JSON.parse(row!.meta)).toMatchObject({
      in_reply_to: 'q-1',
      answer: { choice: 1, text: 'then ping big-body' },
      answer_proof: { channel: 'app', verified: true, by: 'nick' },
    });
    expect((await questionView(s.db, s.team.id, 'q-1'))?.state).toBe('answered');
    const again = await handleRelayCallback(s.ctx, s.team, callback('q-1', body), NOW + 2_000);
    expect(again.ok).toBe(false);
  });

  it('a question answered on /live first refuses the phone with question_already_answered', async () => {
    const s = await seed();
    const qk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await handleRelayCallback(
      s.ctx,
      s.team,
      callback('qk-1', await enrollBody(s, qk.publicKey)),
      NOW,
    );
    const d = await delivered(s, await raiseQuestion(s, 'q-1'));
    await insertMessage(
      s.db,
      s.team.id,
      s.nick.id,
      s.ada.id,
      makeEnvelope({
        id: 'live-answer',
        team: s.team.slug,
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'accept',
        meta: { in_reply_to: 'q-1', answer: { choice: 0 } },
        ts: NOW + 500,
      }),
    );
    await s.db.run(
      `INSERT INTO question_answers (team_id, question_id, answer_id, asker, answered_by, channel, verified, answered_at)
       VALUES (?, 'q-1', 'live-answer', 'ada', 'nick', 'live', 1, ?)`,
      [s.team.id, NOW + 500],
    );
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, qk.privateKey)),
        NOW + 1_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'question_already_answered' });
  });

  it('the question key cannot answer anything that is not a question, and a question takes no decision', async () => {
    const s = await seed();
    const qk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await handleRelayCallback(
      s.ctx,
      s.team,
      callback('qk-1', await enrollBody(s, qk.publicKey)),
      NOW,
    );
    const plain = await raiseAsk(s.db, s.team, s.ada, s.nick, 'ask-1');
    const pd = await delivered(s, plain);
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('ask-1', await questionAnswerBody(s, pd, qk.privateKey)),
        NOW + 1_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'answer_on_non_question' });
    const qd = await delivered(s, await raiseQuestion(s, 'q-1'));
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('q-1', await answerBody(s, qd)), NOW + 1_000),
    ).resolves.toEqual({ ok: false, reason: 'decision_on_question' });
  });

  it('an answer claiming the question key with none enrolled, or signed by a stranger, is refused', async () => {
    const s = await seed();
    const d = await delivered(s, await raiseQuestion(s, 'q-1'));
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, stranger.privateKey)),
        NOW + 1_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'key_revoked' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, stranger.privateKey, { key: 'signing' })),
        NOW + 1_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    // The Face ID key itself may answer from inside the app.
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, s.phone.signing, { key: 'signing' })),
        NOW + 1_000,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('a revoked phone key takes the question key with it', async () => {
    const s = await seed();
    const qk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await handleRelayCallback(
      s.ctx,
      s.team,
      callback('qk-1', await enrollBody(s, qk.publicKey)),
      NOW,
    );
    const d = await delivered(s, await raiseQuestion(s, 'q-1'));
    await revokeDeviceKey(s.db, s.team.id, s.deviceKeyId);
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, qk.privateKey)),
        NOW + 1_000,
      ),
    ).resolves.toEqual({ ok: false, reason: 'key_revoked' });
  });

  it('an enrollment cannot be replayed to roll the key back, nor sealed for far in the future', async () => {
    const s = await seed();
    const k1 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const k2 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const first = await enrollBody(s, k1.publicKey, s.phone.signing, { nonce: 'a'.repeat(24) });
    await expect(handleRelayCallback(s.ctx, s.team, callback('qk-1', first), NOW)).resolves.toEqual(
      { ok: true },
    );
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback(
          'qk-1',
          await enrollBody(s, k2.publicKey, s.phone.signing, {
            nonce: 'b'.repeat(24),
            expiresAt: NOW + 70_000,
          }),
        ),
        NOW,
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('qk-1', first), NOW + 1),
    ).resolves.toEqual({
      ok: false,
      reason: 'replayed',
    });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback(
          'qk-1',
          await enrollBody(s, k1.publicKey, s.phone.signing, {
            nonce: 'c'.repeat(24),
            expiresAt: NOW + 60 * 60_000,
          }),
        ),
        NOW,
      ),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('qk-1', first), NOW + 2 * 60_000),
    ).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('an older enrollment the relay held back cannot land after a newer one (no rollback)', async () => {
    const s = await seed();
    const k1 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const k2 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const older = await enrollBody(s, k1.publicKey, s.phone.signing, {
      nonce: 'o'.repeat(24),
      expiresAt: NOW + 60_000,
    });
    const newer = await enrollBody(s, k2.publicKey, s.phone.signing, {
      nonce: 'w'.repeat(24),
      expiresAt: NOW + 120_000,
    });
    await expect(handleRelayCallback(s.ctx, s.team, callback('qk-1', newer), NOW)).resolves.toEqual(
      {
        ok: true,
      },
    );
    await expect(
      handleRelayCallback(s.ctx, s.team, callback('qk-1', older), NOW + 1),
    ).resolves.toEqual({
      ok: false,
      reason: 'replayed',
    });
    // The key in force is still the newer one: k2 answers, k1 does not.
    const d = await delivered(s, await raiseQuestion(s, 'q-1'));
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, k1.privateKey)),
        NOW + 2,
      ),
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    await expect(
      handleRelayCallback(
        s.ctx,
        s.team,
        callback('q-1', await questionAnswerBody(s, d, k2.privateKey)),
        NOW + 3,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('a racing enrollment that changed the keys between read and write loses (compare-and-swap)', async () => {
    const s = await seed();
    const k1 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // A driver whose transaction lets a rival write land just before our UPDATE — what Postgres's
    // READ COMMITTED allows when two enrollments read the same keys.
    let raced = false;
    const racing = {
      ...s.db,
      tx: <T>(fn: (t: Driver) => Promise<T>) =>
        s.db.tx((t) =>
          fn(
            new Proxy(t, {
              get(target, prop, recv) {
                if (prop !== 'run') return Reflect.get(target, prop, recv);
                return async (sql: string, params: unknown[]) => {
                  if (!raced && sql.startsWith('UPDATE channel_bindings SET app_keys')) {
                    raced = true;
                    const rival = await target.get<{ app_keys: string }>(
                      'SELECT app_keys FROM channel_bindings WHERE id = ?',
                      [s.binding.id],
                    );
                    const keys = JSON.parse(rival!.app_keys) as Record<string, unknown>;
                    await target.run('UPDATE channel_bindings SET app_keys = ? WHERE id = ?', [
                      JSON.stringify({ ...keys, question_key_expires_at: NOW + 999_999 }),
                      s.binding.id,
                    ]);
                  }
                  return target.run(sql, params as never);
                };
              },
            }),
          ),
        ),
    } as Driver;
    await expect(
      setAppQuestionKey(
        racing,
        s.team.id,
        s.binding.id,
        { questionKey: p256Raw(k1.publicKey), nonce: 'r'.repeat(24), expiresAt: NOW + 60_000 },
        NOW,
      ),
    ).resolves.toBe('replayed');
  });
});
