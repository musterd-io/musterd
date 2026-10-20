import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  APP_CHANNEL,
  APP_PUSH_INLINE_MAX_BYTES,
  appAnswerSigningBytes,
  AppAnswerSchema,
  askContract,
  AskTierSchema,
  classifyAskAction,
  makeEnvelope,
  type AppCallback,
  type AppDelivery,
  type Envelope,
  type RelayAppDeliverFrame,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { appBindingKeys, stageAppPairing, type AppKeys } from '../store/appPairing.js';
import {
  askDigest,
  issueAskChannelToken,
  redeemAskChannelToken,
} from '../store/askChannelTokens.js';
import { appendAudit } from '../store/audit.js';
import { getDeviceKey } from '../store/authority.js';
import { listBindings, type ChannelBinding } from '../store/channelBindings.js';
import { deliverAllowed, getChannelSettings } from '../store/channelSettings.js';
import { listMembers } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { humanPresent } from '../store/reachability.js';
import { resolveCapabilities, type TeamRow } from '../store/rows.js';
import { loadAppChannelKeys, openFromPhone, sealToPhone } from './appSeal.js';
import { relayChecks, relayLinkFor, type RelayLink } from './relay.js';

/**
 * The musterd app's channel adapter (ADR 676 §2, §6–§8), the sibling of `slackAdapter.ts`.
 *
 * Out: an advisory ask addressed to a human with an active app binding is signed with the daemon
 * identity key, sealed to the phone's receive key, and handed to the relay as an `app_deliver`
 * frame. The relay sees the route and the ciphertext, never the ask.
 *
 * In: the phone's callbacks arrive through the relay as JSON bodies. A pairing request is staged
 * (`store/appPairing.ts`). An answer is opened with the route it claims, its signature is checked
 * against the binding's enrolled `phone` device key, and only then is it redeemed through ADR 623
 * §6 — the same one transaction as a Slack answer, with the binding's own identity as the
 * provider identity. A re-delivery request re-sends this binding's pending asks with fresh tokens.
 *
 * This increment carries advisory asks only, as Slack does. Privileged asks and ADR 662 listed acts
 * (A2 answers, the descriptor screen, the fatigue ceiling) are the next increment.
 */

/** `<Apple team id>.<bundle id>` — what App Attest's RP id hash must be. */
export function appAttestAppId(env: NodeJS.ProcessEnv = process.env): string {
  return env['MUSTERD_APP_ATTEST_APP_ID'] ?? 'D27MJGWNY3.io.musterd.app';
}

/** The delivery nonce for a token: unique per token, derivable, so the daemon stores nothing for it. */
export function appDeliveryNonce(token: string): string {
  return createHash('sha256')
    .update(`musterd-app-nonce/v1\n${token}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Re-sends per redeliver request — a pending set past this is older than the phone needs. */
const REDELIVER_MAX = 20;

async function sendSealed(
  ctx: Ctx,
  team: { id: string; slug: string },
  link: RelayLink,
  input: {
    binding: ChannelBinding;
    keys: AppKeys;
    ref: string;
    expiresAt: number;
    dedupeId: string;
    delivery: AppDelivery;
  },
): Promise<boolean> {
  const sealed = await sealToPhone({
    keys: await loadAppChannelKeys(),
    phoneReceivePublic: input.keys.receive_public_key,
    route: {
      team: team.slug,
      binding: input.binding.id,
      ref: input.ref,
      expires_at: input.expiresAt,
    },
    payload: new TextEncoder().encode(JSON.stringify(input.delivery)),
  });
  const frame: RelayAppDeliverFrame = {
    protocol: 1,
    type: 'app_deliver',
    ask_ref: input.ref,
    dedupe_id: input.dedupeId,
    expires_at: input.expiresAt,
    binding: input.binding.id,
    sealed,
  };
  const sent = link.send(frame);
  const size =
    Buffer.from(sealed.ct, 'base64url').length + Buffer.from(sealed.enc, 'base64url').length;
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action: 'channel.sealed_delivered',
    target: input.ref,
    result: sent ? 'allow' : 'deny',
    detail: {
      kind: input.delivery.kind,
      binding_id: input.binding.id,
      size,
      mode: size <= APP_PUSH_INLINE_MAX_BYTES ? 'inline' : 'fetch',
      ...(sent ? {} : { reason: 'relay_not_connected' }),
    },
  });
  return sent;
}

async function activeAppBinding(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<{ binding: ChannelBinding; keys: AppKeys } | null> {
  const binding = (await listBindings(db, teamId, memberId)).find(
    (b) => b.channel === APP_CHANNEL && b.status === 'active',
  );
  if (!binding) return null;
  const keys = await appBindingKeys(db, teamId, binding.id);
  return keys ? { binding, keys } : null;
}

interface AskRow {
  id: string;
  body: string;
  meta: string | null;
  ts: number;
  from_name: string;
  from_kind: string;
}

async function loadAsk(db: Driver, teamId: string, askId: string): Promise<AskRow | null> {
  return (
    (await db.get<AskRow>(
      `SELECT msg.id, msg.body, msg.meta, msg.ts, m.name AS from_name, m.kind AS from_kind
         FROM messages msg JOIN members m ON m.id = msg.from_member AND m.team_id = msg.team_id
        WHERE msg.team_id = ? AND msg.id = ?`,
      [teamId, askId],
    )) ?? null
  );
}

function parseMeta(meta: string | null): Record<string, unknown> | null {
  try {
    return meta ? (JSON.parse(meta) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Issue a token for one ask on one app binding and send the sealed delivery. */
async function deliverOne(
  ctx: Ctx,
  team: { id: string; slug: string },
  link: RelayLink,
  ask: AskRow,
  target: { binding: ChannelBinding; keys: AppKeys },
  expiresAt: number,
): Promise<boolean> {
  const meta = parseMeta(ask.meta);
  const tier = AskTierSchema.safeParse(meta?.['tier']);
  const { token } = await issueAskChannelToken(ctx.db, {
    teamId: team.id,
    askId: ask.id,
    askDigest: askDigest(ask.body, ask.meta),
    actionClass: 'advisory',
    channel: APP_CHANNEL,
    bindingId: target.binding.id,
    bindingGeneration: target.binding.generation,
    requiredAssurance: 'A1',
    expiresAt,
    now: Date.now(),
  });
  return sendSealed(ctx, team, link, {
    ...target,
    ref: ask.id,
    expiresAt,
    dedupeId: `${ask.id}:app:${target.binding.id}`,
    delivery: {
      v: 1,
      kind: 'ask',
      team: team.slug,
      binding: target.binding.id,
      ask: {
        id: ask.id,
        from: ask.from_name,
        from_kind: ask.from_kind === 'human' ? 'human' : 'agent',
        body: ask.body,
        tier: tier.success ? tier.data : 'standard',
        species: typeof meta?.['species'] === 'string' ? meta['species'] : null,
        action_class: 'advisory',
        ts: ask.ts,
      },
      token,
      nonce: appDeliveryNonce(token),
      expires_at: expiresAt,
    },
  });
}

/**
 * Deliver one routed ask to each addressed human's app binding. Detached by the caller, like the
 * Slack adapter: a missing relay or a failed hand-off is logged and the ask is untouched.
 */
export async function deliverAskToAppChannels(
  ctx: Ctx,
  team: TeamRow,
  env: Envelope,
): Promise<void> {
  try {
    if (env.act !== 'ask') return;
    if (classifyAskAction(env.meta ?? null) !== 'advisory') return;
    const link = relayLinkFor(ctx, team.slug);
    if (!link) return;
    const ask = await loadAsk(ctx.db, team.id, env.id);
    if (!ask) return;
    const tierParsed = AskTierSchema.safeParse((env.meta as { tier?: unknown } | undefined)?.tier);
    const askTier = tierParsed.success ? tierParsed.data : 'standard';
    const expiresAt = env.ts + askContract(askTier).timeout_ms;
    const members = await listMembers(ctx.db, team.id);
    const humans = members.filter((m) => m.kind === 'human');
    const addressed =
      env.to.kind === 'member'
        ? humans.filter((m) => m.name === (env.to as { name: string }).name)
        : humans.filter((m) => resolveCapabilities(m).is_admin);
    for (const human of addressed) {
      const settings = await getChannelSettings(ctx.db, team.id, human.id, APP_CHANNEL);
      if (!deliverAllowed(settings, askTier)) continue;
      if (
        settings.presenceGating &&
        (await humanPresent(ctx.db, team.id, human, ctx.config.presenceTimeoutMs))
      ) {
        continue;
      }
      const target = await activeAppBinding(ctx.db, team.id, human.id);
      if (!target) continue;
      const sent = await deliverOne(ctx, team, link, ask, target, expiresAt);
      log.info({
        msg: sent ? 'away_app_deliver_queued' : 'away_app_delivery_failed',
        team: team.slug,
        ask: env.id,
        reason: sent ? undefined : 'relay_not_connected',
      });
    }
  } catch (err) {
    log.warn({ msg: 'away_app_delivery_failed', team: team.slug, ask: env.id, err: String(err) });
  }
}

/** The signed "paired" delivery the phone shows after the human approved its key (ADR 676 §5 step 6). */
export async function sendAppPaired(
  ctx: Ctx,
  team: { id: string; slug: string },
  input: { binding: ChannelBinding; member: string; deviceKeyId: string; pairingId: string },
): Promise<boolean> {
  const link = relayLinkFor(ctx, team.slug);
  const keys = await appBindingKeys(ctx.db, team.id, input.binding.id);
  if (!link || !keys) return false;
  return sendSealed(ctx, team, link, {
    binding: input.binding,
    keys,
    ref: input.pairingId,
    expiresAt: Date.now() + 10 * 60_000,
    dedupeId: `${input.pairingId}:paired`,
    delivery: {
      v: 1,
      kind: 'paired',
      team: team.slug,
      binding: input.binding.id,
      member: input.member,
      device_key_id: input.deviceKeyId,
    },
  });
}

export type AppCallbackRefusal =
  | 'binding_stale'
  | 'sealed_body'
  | 'bad_request'
  | 'nonce_mismatch'
  | 'key_revoked'
  | 'bad_signature';

/**
 * One callback from the phone, already parsed through `AppCallbackSchema` by the relay client.
 * Every refusal is a plain reason; none says which byte failed.
 */
export async function handleAppCallback(
  ctx: Ctx,
  team: { id: string; slug: string },
  cb: AppCallback,
  now: number = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  if (cb.kind === 'pair') {
    const staged = await stageAppPairing(ctx.db, {
      teamId: team.id,
      teamSlug: team.slug,
      pairingId: cb.ref,
      sealed: cb.sealed,
      keys: await loadAppChannelKeys(),
      appId: appAttestAppId(),
      now,
    });
    return staged.ok ? { ok: true } : { ok: false, reason: staged.reason };
  }

  const binding = await ctx.db.get<ChannelBinding>(
    `SELECT * FROM channel_bindings WHERE id = ? AND team_id = ? AND channel = ? AND status = 'active'`,
    [cb.binding, team.id, APP_CHANNEL],
  );
  const keys = binding ? await appBindingKeys(ctx.db, team.id, binding.id) : null;
  if (!binding || !keys) return { ok: false, reason: 'binding_stale' };

  if (cb.kind === 'redeliver') return redeliver(ctx, team, binding, keys, now);

  let opened: Uint8Array;
  try {
    opened = await openFromPhone({
      keys: await loadAppChannelKeys(),
      route: { team: team.slug, binding: binding.id, ref: cb.ref, expires_at: cb.expires_at },
      sealed: cb.sealed,
      purpose: 'answer',
    });
  } catch {
    return { ok: false, reason: 'sealed_body' };
  }
  const parsed = (() => {
    try {
      return AppAnswerSchema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    } catch {
      return null;
    }
  })();
  if (!parsed?.success) return { ok: false, reason: 'bad_request' };
  const answer = parsed.data;
  const reported = answer.reported === true && answer.decision === 'reject';
  if (answer.nonce !== appDeliveryNonce(answer.token))
    return { ok: false, reason: 'nonce_mismatch' };

  // The answer is the phone's: a fresh signature by the binding's enrolled `phone` key.
  const key = keys.device_key_id ? await getDeviceKey(ctx.db, team.id, keys.device_key_id) : null;
  if (!key || key.revokedAt !== null || key.kind !== 'phone' || key.memberId !== binding.member_id)
    return { ok: false, reason: 'key_revoked' };
  const signed = appAnswerSigningBytes({
    team: team.slug,
    binding: binding.id,
    ask: cb.ref,
    token: answer.token,
    decision: answer.decision,
    nonce: answer.nonce,
    reported,
  });
  let valid = false;
  try {
    valid = cryptoVerify(
      'sha256',
      Buffer.from(signed, 'utf8'),
      createPublicKey({
        key: Buffer.from(key.publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(answer.signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const messageId = `app-${cb.ref}-${now}`;
  const result = await redeemAskChannelToken(
    ctx.db,
    {
      teamId: team.id,
      token: answer.token,
      askId: cb.ref,
      assurance: 'A1',
      decision: answer.decision,
      answerMessageId: messageId,
      providerIdentity: { tenantId: binding.provider_tenant_id, userId: binding.provider_user_id },
      deliveryActor: 'app',
      now,
      writeAnswer: async (t, authorizer) => {
        await insertMessage(
          t,
          team.id,
          authorizer.memberId,
          null,
          makeEnvelope({
            id: messageId,
            team: team.slug,
            from: authorizer.memberName,
            to: { kind: 'team' },
            act: 'message',
            body:
              answer.decision === 'approve'
                ? 'Approved in the musterd app'
                : 'Rejected in the musterd app',
            meta: {
              in_reply_to: cb.ref,
              channel_answer: {
                channel: APP_CHANNEL,
                assurance: 'A1',
                decision: answer.decision,
                signed_by: key.id,
              },
            },
            ts: now,
          }),
        );
      },
    },
    relayChecks,
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  if (reported) {
    const ask = await loadAsk(ctx.db, team.id, cb.ref);
    await appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'channel.answer_reported',
      target: cb.ref,
      result: 'allow',
      detail: { asking_seat: ask?.from_name ?? 'unknown', binding_id: binding.id },
    });
  }
  return { ok: true };
}

/**
 * The phone opened and asked for what is still pending on its binding (ADR 676 §9: a missed push is
 * not a lost ask). Each pending ask is re-sent with a fresh token; the token it replaces is spent,
 * so one live token per ask and binding remains. Decided, expired and changed asks are skipped.
 */
async function redeliver(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  keys: AppKeys,
  now: number,
): Promise<{ ok: boolean; reason?: string }> {
  const link = relayLinkFor(ctx, team.slug);
  if (!link) return { ok: false, reason: 'relay_not_connected' };
  const pending = await ctx.db.all<{
    token_hash: string;
    ask_id: string;
    expires_at: number;
    ask_digest: string;
  }>(
    `SELECT t.token_hash, t.ask_id, t.expires_at, t.ask_digest FROM ask_channel_tokens t
      WHERE t.team_id = ? AND t.binding_id = ? AND t.binding_generation = ?
        AND t.consumed_at IS NULL AND t.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM ask_decisions d WHERE d.team_id = t.team_id AND d.ask_id = t.ask_id)
      ORDER BY t.created_at LIMIT ?`,
    [team.id, binding.id, binding.generation, now, REDELIVER_MAX],
  );
  for (const row of pending) {
    const ask = await loadAsk(ctx.db, team.id, row.ask_id);
    if (!ask || askDigest(ask.body, ask.meta) !== row.ask_digest) continue;
    if (classifyAskAction(parseMeta(ask.meta)) !== 'advisory') continue;
    await ctx.db.run(
      'UPDATE ask_channel_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL',
      [now, row.token_hash],
    );
    await deliverOne(ctx, team, link, ask, { binding, keys }, row.expires_at);
  }
  return { ok: true };
}
