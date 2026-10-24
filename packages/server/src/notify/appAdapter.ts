import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  acceptanceAskContract,
  APP_CHANNEL,
  APP_LISTED_ACT_HOURLY_MAX,
  APP_LISTED_ACT_OPEN_MAX,
  APP_PUSH_INLINE_MAX_BYTES,
  appAnswerSigningBytes,
  AppAnswerSchema,
  askContract,
  AskTierSchema,
  classifyAskAction,
  isAwaitingAcceptance,
  makeEnvelope,
  sealedPushBytes,
  type AppApproval,
  type AppCallback,
  type AppAnswer,
  type AppDelivery,
  type Envelope,
  type RelayAppDeliverFrame,
  type RelayAppFetchFrame,
  type SealedBodyWire,
} from '@musterd/protocol';
import { humanAskAnswerApproval } from '@musterd/protocol/approval';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { appBindingKeys, stageAppPairing, type AppKeys } from '../store/appPairing.js';
import {
  askDigest,
  issueAskChannelToken,
  redeemAskChannelToken,
} from '../store/askChannelTokens.js';
import { appendAudit, listAuditByAction } from '../store/audit.js';
import { buildDescriptor, getDeviceKey, requireAuthority } from '../store/authority.js';
import { listBindings, type ChannelBinding } from '../store/channelBindings.js';
import { deliverAllowed, getChannelSettings } from '../store/channelSettings.js';
import { getLane } from '../store/lanes.js';
import { getMemberById, listMembers } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { humanPresent } from '../store/reachability.js';
import { isAdvisoryReviewMeta } from '../store/review.js';
import { resolveCapabilities, type MemberRow, type TeamRow } from '../store/rows.js';
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
 * The relay pushes each delivery to the binding's APNs token (ADR 676 §9). A body too large for
 * the push travels by ask ref, and the phone fetches it: the relay's `app_fetch` lands in
 * {@link handleAppFetch}, which re-issues that one ask's delivery and answers with the sealed body.
 *
 * Privileged asks (ADR 694): the one kind delivered is a human's verdict on a lane review — ADR
 * 662's listed act `human_accept`, whose act-path gate already exists. Its delivery carries an A2
 * token and two server-built descriptors (accept, decline); the phone's answer carries a device
 * signature over the one it chose, and is performed as that human's own `accept`/`decline` through
 * `routeEnvelope`, where `requireAuthority` verifies it like any passkey verdict. One verifier, one
 * door. Other privileged asks stay off the phone until the act they answer has a gate of its own.
 * The fatigue ceiling (ADR 676 §8) meters verdict asks per human: one live on the phone at a time,
 * at most six first-delivered from agent seats in a rolling hour (one `held` summary past that).
 * Both are read from the token table, so nothing new is stored; the queue moves on a new ask, an
 * answer, and the phone's re-delivery on open.
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

interface SealInput {
  binding: ChannelBinding;
  keys: AppKeys;
  ref: string;
  expiresAt: number;
  delivery: AppDelivery;
}

async function sealDelivery(
  team: { id: string; slug: string },
  input: SealInput,
): Promise<SealedBodyWire> {
  return sealToPhone({
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
}

async function auditSealed(
  ctx: Ctx,
  team: { id: string },
  input: SealInput,
  sealed: SealedBodyWire | null,
  mode: 'inline' | 'fetch' | 'fetched',
  reason?: string,
): Promise<void> {
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action: 'channel.sealed_delivered',
    target: input.ref,
    result: reason ? 'deny' : 'allow',
    detail: {
      kind: input.delivery.kind,
      binding_id: input.binding.id,
      ...(sealed ? { size: sealedPushBytes(sealed) } : {}),
      mode,
      ...(reason ? { reason } : {}),
    },
  });
}

async function sendSealed(
  ctx: Ctx,
  team: { id: string; slug: string },
  link: RelayLink,
  input: SealInput & { dedupeId: string },
): Promise<boolean> {
  // A binding paired without a push token has nowhere to be pushed; the phone still gets its
  // pending set when it opens and asks for a re-delivery, which also lands here, so say so.
  if (!input.keys.push_token) {
    await auditSealed(ctx, team, input, null, 'inline', 'no_push_token');
    return false;
  }
  const sealed = await sealDelivery(team, input);
  const frame: RelayAppDeliverFrame = {
    protocol: 1,
    type: 'app_deliver',
    ask_ref: input.ref,
    dedupe_id: input.dedupeId,
    expires_at: input.expiresAt,
    binding: input.binding.id,
    push: {
      token: input.keys.push_token,
      environment: input.keys.push_environment ?? input.keys.environment,
    },
    sealed,
  };
  const sent = link.send(frame);
  await auditSealed(
    ctx,
    team,
    input,
    sealed,
    sealedPushBytes(sealed) <= APP_PUSH_INLINE_MAX_BYTES ? 'inline' : 'fetch',
    sent ? undefined : 'relay_not_connected',
  );
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
  thread_id: string | null;
  from_name: string;
  from_kind: string;
}

async function loadAsk(db: Driver, teamId: string, askId: string): Promise<AskRow | null> {
  return (
    (await db.get<AskRow>(
      `SELECT msg.id, msg.body, msg.meta, msg.ts, msg.thread_id, m.name AS from_name, m.kind AS from_kind
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

/**
 * The lane a privileged ask is a human verdict on (ADR 694), or null. `lane_review` is
 * daemon-stamped (ADR 225) — a client copy is stripped at the route — so its presence is the
 * daemon's own word that the answer is ADR 662's `human_accept` on that lane. An advisory review
 * ask (ADR 667) moves no lane and stays advisory.
 */
export function laneVerdictOf(
  meta: Record<string, unknown> | null,
): { id: string; title: string } | null {
  if (classifyAskAction(meta) !== 'privileged' || isAdvisoryReviewMeta(meta)) return null;
  const review = meta?.['lane_review'] as { lane?: unknown; title?: unknown } | undefined;
  if (typeof review?.lane !== 'string' || review.lane.length === 0) return null;
  return { id: review.lane, title: typeof review.title === 'string' ? review.title : '' };
}

/** What the app channel carries for an ask: advisory or a privileged human answer. */
function appAskKind(
  meta: Record<string, unknown> | null,
): { class: 'advisory' } | { class: 'privileged'; lane?: { id: string; title: string } } | null {
  if (classifyAskAction(meta) === 'advisory') return { class: 'advisory' };
  const lane = laneVerdictOf(meta);
  return { class: 'privileged', ...(lane ? { lane } : {}) };
}

/** The two verdicts' payloads, exactly as `applyAcceptanceVerdict` builds them for the gate. */
const verdictPayload = (lane: string, verdict: 'accept' | 'decline') => ({ lane, verdict });

/**
 * The descriptors for a verdict ask: one per decision, built for the binding's human, so the
 * signature over either is a signature for that act and no other (ADR 662 decision 5).
 */
async function buildVerdictApproval(
  ctx: Ctx,
  team: { id: string; slug: string },
  human: { id: string; name: string },
  lane: string,
): Promise<AppApproval> {
  const offer = async (verdict: 'accept' | 'decline') => {
    const payload = verdictPayload(lane, verdict);
    const descriptor = await buildDescriptor(ctx.db, {
      teamId: team.id,
      audience: team.slug,
      memberId: human.id,
      actor: human.name,
      act: 'human_accept',
      target: lane,
      payload,
    });
    return { descriptor, payload };
  };
  return { approve: await offer('accept'), reject: await offer('decline') };
}

async function buildAskAnswerApproval(
  ctx: Ctx,
  team: { id: string; slug: string },
  human: { id: string; name: string },
  askId: string,
): Promise<AppApproval> {
  const offer = async (verdict: 'accept' | 'decline') => {
    const action = humanAskAnswerApproval(askId, verdict);
    const descriptor = await buildDescriptor(ctx.db, {
      teamId: team.id,
      audience: team.slug,
      memberId: human.id,
      actor: human.name,
      ...action,
    });
    return { descriptor, payload: action.payload };
  };
  return { approve: await offer('accept'), reject: await offer('decline') };
}

/** Issue a token for one ask on one app binding and build the delivery that carries it. */
async function issueAskDelivery(
  ctx: Ctx,
  team: { id: string; slug: string },
  ask: AskRow,
  target: { binding: ChannelBinding; keys: AppKeys },
  expiresAt: number,
  opts: { now?: number; waiting?: number } = {},
): Promise<SealInput> {
  const now = opts.now ?? Date.now();
  const meta = parseMeta(ask.meta);
  const tier = AskTierSchema.safeParse(meta?.['tier']);
  const kind = appAskKind(meta);
  if (!kind) throw new Error('this ask is not one the app channel carries');
  const privileged = kind.class === 'privileged';
  const human = privileged ? await getMemberById(ctx.db, target.binding.member_id) : undefined;
  if (privileged && human?.kind !== 'human') throw new Error('a verdict ask needs a human binding');
  const { token } = await issueAskChannelToken(ctx.db, {
    teamId: team.id,
    askId: ask.id,
    askDigest: askDigest(ask.body, ask.meta),
    actionClass: kind.class,
    channel: APP_CHANNEL,
    bindingId: target.binding.id,
    bindingGeneration: target.binding.generation,
    requiredAssurance: privileged ? 'A2' : 'A1',
    expiresAt,
    now,
  });
  const approval =
    kind.class === 'privileged' && human
      ? kind.lane
        ? await buildVerdictApproval(ctx, team, human, kind.lane.id)
        : await buildAskAnswerApproval(ctx, team, human, ask.id)
      : undefined;
  return {
    ...target,
    ref: ask.id,
    expiresAt,
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
        action_class: kind.class,
        ts: ask.ts,
      },
      ...(approval ? { approval } : {}),
      ...(kind.class === 'privileged' && kind.lane
        ? { lane: kind.lane, waiting: opts.waiting ?? 0 }
        : {}),
      token,
      nonce: appDeliveryNonce(token),
      expires_at: expiresAt,
    },
  };
}

/** Issue a token for one ask on one app binding and send the sealed delivery. */
async function deliverOne(
  ctx: Ctx,
  team: { id: string; slug: string },
  link: RelayLink,
  ask: AskRow,
  target: { binding: ChannelBinding; keys: AppKeys },
  expiresAt: number,
  opts: { now?: number; waiting?: number } = {},
): Promise<boolean> {
  const input = await issueAskDelivery(ctx, team, ask, target, expiresAt, opts);
  return sendSealed(ctx, team, link, { ...input, dedupeId: `${ask.id}:app:${target.binding.id}` });
}

/**
 * Deliver one routed ask to each addressed human's app binding. Detached by the caller, like the
 * Slack adapter: a missing relay or a failed hand-off is logged and the ask is untouched. An
 * advisory ask goes out at once; a verdict ask joins that human's queue (ADR 676 §8).
 */
export async function deliverAskToAppChannels(
  ctx: Ctx,
  team: TeamRow,
  env: Envelope,
  now: number = Date.now(),
): Promise<void> {
  try {
    if (env.act !== 'ask') return;
    const kind = appAskKind((env.meta as Record<string, unknown> | undefined) ?? null);
    if (!kind) return;
    const link = relayLinkFor(ctx, team.slug);
    if (!link) return;
    const ask = await loadAsk(ctx.db, team.id, env.id);
    if (!ask) return;
    const members = await listMembers(ctx.db, team.id);
    const humans = members.filter((m) => m.kind === 'human');
    const addressed =
      env.to.kind === 'member'
        ? humans.filter((m) => m.name === (env.to as { name: string }).name)
        : humans.filter((m) => resolveCapabilities(m).is_admin);
    for (const human of addressed) {
      if (kind.class === 'privileged') {
        await tickVerdictQueue(ctx, team, human, now, ask.id);
        continue;
      }
      const target = await appTargetFor(ctx, team, human, askTierOf(ask));
      if (!target) continue;
      const sent = await deliverOne(ctx, team, link, ask, target, askExpiry(ask), { now });
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

function askTierOf(ask: AskRow) {
  const tier = AskTierSchema.safeParse(parseMeta(ask.meta)?.['tier']);
  return tier.success ? tier.data : 'standard';
}

/**
 * When an ask's token dies: its tier's contract from when it was raised — and for a verdict ask the
 * review window the daemon promised (ADR 506), not the bare tier, or a queued verdict would expire
 * before its turn came.
 */
function askExpiry(ask: AskRow): number {
  const meta = parseMeta(ask.meta);
  if (!laneVerdictOf(meta)) return ask.ts + askContract(askTierOf(ask)).timeout_ms;
  const wait = (meta?.['lane_review'] as { wait_ms?: unknown } | undefined)?.wait_ms;
  return (
    ask.ts +
    acceptanceAskContract(askTierOf(ask), typeof wait === 'number' ? wait : undefined).timeout_ms
  );
}

/** The human's app binding, if the channel's settings and presence gate let this tier through. */
async function appTargetFor(
  ctx: Ctx,
  team: { id: string },
  human: MemberRow,
  tier: ReturnType<typeof askTierOf>,
): Promise<{ binding: ChannelBinding; keys: AppKeys } | null> {
  const settings = await getChannelSettings(ctx.db, team.id, human.id, APP_CHANNEL);
  if (!deliverAllowed(settings, tier)) return null;
  if (
    settings.presenceGating &&
    (await humanPresent(ctx.db, team.id, human, ctx.config.presenceTimeoutMs))
  ) {
    return null;
  }
  return activeAppBinding(ctx.db, team.id, human.id);
}

const HOUR_MS = 60 * 60_000;
/** How far back pending privileged asks are looked for: past any review window a team sets. */
const PENDING_LOOKBACK_MS = 7 * 24 * HOUR_MS;

/**
 * The privileged asks this human still owes, oldest first. A retried lane-stage ask supersedes
 * the older ask for that lane; other privileged asks remain independent. Each is addressed to this
 * human (or to the admins, when they are one), undecided, and unexpired. Lane asks also require the
 * lane to still await acceptance; a checked /live answer drops a general ask from the queue.
 */
async function pendingPrivilegedAsks(
  ctx: Ctx,
  team: { id: string; slug: string },
  human: MemberRow,
  now: number,
): Promise<AskRow[]> {
  const rows = await ctx.db.all<AskRow & { to_kind: string; to_member: string | null }>(
    `SELECT msg.id, msg.body, msg.meta, msg.ts, msg.thread_id, msg.to_kind, msg.to_member,
            m.name AS from_name, m.kind AS from_kind
       FROM messages msg JOIN members m ON m.id = msg.from_member AND m.team_id = msg.team_id
      WHERE msg.team_id = ? AND msg.act = 'ask' AND msg.ts > ?
        AND NOT EXISTS (SELECT 1 FROM ask_decisions d WHERE d.team_id = msg.team_id AND d.ask_id = msg.id)
        AND NOT EXISTS (
          SELECT 1 FROM messages a JOIN members author ON author.id = a.from_member AND author.team_id = a.team_id
           WHERE a.team_id = msg.team_id AND a.act IN ('accept', 'decline') AND author.kind = 'human'
             AND json_extract(a.meta, '$.in_reply_to') = msg.id
             AND json_extract(a.meta, '$.human_authority_checked') = 1
        )
      ORDER BY msg.ts, msg.id`,
    [team.id, now - PENDING_LOOKBACK_MS],
  );
  const isAdmin = resolveCapabilities(human).is_admin;
  const byLane = new Map<string, AskRow>();
  const general: AskRow[] = [];
  for (const row of rows) {
    if (row.to_member !== human.id && !(row.to_kind === 'team' && isAdmin)) continue;
    const meta = parseMeta(row.meta);
    if (classifyAskAction(meta) !== 'privileged' || askExpiry(row) <= now) continue;
    const lane = laneVerdictOf(meta);
    if (!lane) {
      general.push(row);
      continue;
    }
    const state = (await getLane(ctx.db, team.id, lane.id, team.slug))?.state;
    if (!state || !isAwaitingAcceptance(state)) continue;
    byLane.delete(lane.id); // the newer ask for a lane takes the older one's place
    byLane.set(lane.id, row);
  }
  return [...general, ...byLane.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

async function hourlyHoldRecorded(
  ctx: Ctx,
  team: { id: string },
  bindingId: string,
  until: number,
): Promise<boolean> {
  const rows = await listAuditByAction(ctx.db, team.id, 'channel.fatigue_held', 50);
  return rows.some((r) => {
    try {
      const d = JSON.parse(String(r.detail)) as {
        reason?: string;
        until?: number;
        binding_id?: string;
      };
      return d.reason === 'hourly' && d.until === until && d.binding_id === bindingId;
    } catch {
      return false;
    }
  });
}

/** How many privileged asks wait behind `askId` for this human — what a delivery says. */
async function waitingBehind(
  ctx: Ctx,
  team: { id: string; slug: string },
  human: MemberRow | undefined,
  askId: string,
  now: number,
): Promise<number> {
  if (human?.kind !== 'human') return 0;
  return (await pendingPrivilegedAsks(ctx, team, human, now)).filter((a) => a.id !== askId).length;
}

/**
 * The privileged asks live on this binding now. A lane token whose lane was decided elsewhere is
 * spent here; checked answers to general asks are filtered by their server-owned marker.
 */
async function openVerdicts(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  now: number,
): Promise<string[]> {
  const rows = await ctx.db.all<{ token_hash: string; ask_id: string }>(
    `SELECT t.token_hash, t.ask_id FROM ask_channel_tokens t
      WHERE t.team_id = ? AND t.binding_id = ? AND t.binding_generation = ?
        AND t.action_class = 'privileged' AND t.consumed_at IS NULL AND t.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM ask_decisions d WHERE d.team_id = t.team_id AND d.ask_id = t.ask_id)
        AND NOT EXISTS (
          SELECT 1 FROM messages a JOIN members author ON author.id = a.from_member AND author.team_id = a.team_id
           WHERE a.team_id = t.team_id AND a.act IN ('accept', 'decline') AND author.kind = 'human'
             AND json_extract(a.meta, '$.in_reply_to') = t.ask_id
             AND json_extract(a.meta, '$.human_authority_checked') = 1
        )`,
    [team.id, binding.id, binding.generation, now],
  );
  const open = new Set<string>();
  for (const row of rows) {
    const ask = await loadAsk(ctx.db, team.id, row.ask_id);
    const lane = ask ? laneVerdictOf(parseMeta(ask.meta)) : null;
    if (!lane) {
      if (ask && classifyAskAction(parseMeta(ask.meta)) === 'privileged') open.add(row.ask_id);
      else await spend(ctx, row.token_hash, now);
      continue;
    }
    const state = (await getLane(ctx.db, team.id, lane.id, team.slug))?.state;
    if (state && isAwaitingAcceptance(state)) open.add(row.ask_id);
    else await spend(ctx, row.token_hash, now);
  }
  return [...open];
}

/**
 * Verdict asks from agent seats first delivered to this binding in the rolling hour, and when the
 * oldest of them leaves it. A re-issue (re-delivery, fetch) is the same ask, so it is counted once,
 * at its first token.
 */
async function agentDeliveriesThisHour(
  ctx: Ctx,
  team: { id: string },
  binding: ChannelBinding,
  now: number,
): Promise<{ count: number; until: number }> {
  const rows = await ctx.db.all<{ first: number }>(
    `SELECT MIN(t.created_at) AS first FROM ask_channel_tokens t
       JOIN messages msg ON msg.id = t.ask_id AND msg.team_id = t.team_id
       JOIN members m ON m.id = msg.from_member AND m.team_id = msg.team_id
      WHERE t.team_id = ? AND t.binding_id = ? AND t.action_class = 'privileged' AND m.kind <> 'human'
      GROUP BY t.ask_id`,
    [team.id, binding.id],
  );
  const inHour = rows.map((r) => Number(r.first)).filter((t) => t > now - HOUR_MS);
  return { count: inHour.length, until: inHour.length ? Math.min(...inHour) + HOUR_MS : now };
}

/**
 * Move one human's privileged-ask queue (ADR 676 §8). With no listed act live on their phone, the oldest
 * pending one goes out, saying how many wait behind it — unless it is from an agent seat and the
 * hour's six are spent, when it is held (an ask from a human is not metered by the hourly rule and
 * may go ahead of held ones). The first hold of a burst sends one `held` summary and audits it.
 * `arrived` names the ask whose arrival called this; a `one_open` hold is audited only for it, so a
 * re-tick writes nothing.
 */
export async function tickVerdictQueue(
  ctx: Ctx,
  team: { id: string; slug: string },
  human: MemberRow,
  now: number = Date.now(),
  arrived?: string,
): Promise<void> {
  const link = relayLinkFor(ctx, team.slug);
  if (!link) return;
  const pending = await pendingPrivilegedAsks(ctx, team, human, now);
  const target = pending.length
    ? await appTargetFor(ctx, team, human, askTierOf(pending[0]!))
    : null;
  if (!target) return;
  const open = await openVerdicts(ctx, team, target.binding, now);
  const waiting = pending.filter((a) => !open.includes(a.id));
  const auditOneOpen = async (count: number) => {
    if (!arrived || !waiting.some((a) => a.id === arrived)) return;
    await appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'channel.fatigue_held',
      target: arrived,
      result: 'deny',
      detail: { human: human.name, reason: 'one_open', count, binding_id: target.binding.id },
    });
  };
  if (open.length >= APP_LISTED_ACT_OPEN_MAX) {
    await auditOneOpen(waiting.length);
    return;
  }
  const hour = await agentDeliveriesThisHour(ctx, team, target.binding, now);
  const capped = hour.count >= APP_LISTED_ACT_HOURLY_MAX;
  const next = waiting.find((a) => !capped || a.from_kind === 'human');
  const held = capped ? waiting.filter((a) => a.from_kind !== 'human') : [];
  // One summary per burst. A burst is named by when its oldest delivery leaves the hour: the hold
  // lasts exactly until then, so a recorded hold for this `until` means the summary went out.
  if (held.length > 0 && !(await hourlyHoldRecorded(ctx, team, target.binding.id, hour.until))) {
    await appendAudit(ctx.db, team.id, {
      actor: null,
      action: 'channel.fatigue_held',
      target: held[0]!.id,
      result: 'deny',
      detail: {
        human: human.name,
        reason: 'hourly',
        count: held.length,
        until: hour.until,
        binding_id: target.binding.id,
      },
    });
    await sendSealed(ctx, team, link, {
      ...target,
      ref: `held-${target.binding.id}-${now}`,
      expiresAt: hour.until,
      dedupeId: `held-${target.binding.id}-${hour.until}`,
      delivery: {
        v: 1,
        kind: 'held',
        team: team.slug,
        binding: target.binding.id,
        count: held.length,
        until: hour.until,
      },
    });
  }
  if (!next) return;
  const sent = await deliverOne(ctx, team, link, next, target, askExpiry(next), {
    now,
    waiting: waiting.length - 1,
  });
  log.info({
    msg: sent ? 'away_app_deliver_queued' : 'away_app_delivery_failed',
    team: team.slug,
    ask: next.id,
    reason: sent ? undefined : 'relay_not_connected',
  });
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
  | 'bad_signature'
  | 'no_signature';

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
  const ask = await loadAsk(ctx.db, team.id, cb.ref);
  const lane = ask ? laneVerdictOf(parseMeta(ask.meta)) : null;
  if (ask && lane) {
    return answerVerdict(ctx, team, {
      binding,
      keys,
      key,
      ask,
      lane,
      answer,
      messageId,
      now,
      reported,
    });
  }
  if (ask && appAskKind(parseMeta(ask.meta))?.class === 'privileged') {
    return answerPrivilegedAsk(ctx, team, {
      binding,
      key,
      ask,
      answer,
      messageId,
      now,
      reported,
    });
  }
  // An answer carrying a proof for an advisory ask is malformed.
  if (answer.approval) return { ok: false, reason: 'bad_request' };
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
  if (reported) await auditReported(ctx, team, cb.ref, ask?.from_name, binding.id);
  return { ok: true };
}

async function answerPrivilegedAsk(
  ctx: Ctx,
  team: { id: string; slug: string },
  input: {
    binding: ChannelBinding;
    key: { id: string };
    ask: AskRow;
    answer: AppAnswer;
    messageId: string;
    now: number;
    reported: boolean;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const { binding, ask, answer, now } = input;
  const proof = answer.approval;
  if (!proof) return { ok: false, reason: 'no_signature' };
  if (proof.key_id !== input.key.id) return { ok: false, reason: 'key_revoked' };
  const pre = await redeemAskChannelToken(
    ctx.db,
    {
      teamId: team.id,
      token: answer.token,
      askId: ask.id,
      assurance: 'A2',
      decision: answer.decision,
      answerMessageId: input.messageId,
      providerIdentity: {
        tenantId: binding.provider_tenant_id,
        userId: binding.provider_user_id,
      },
      deliveryActor: 'app',
      now,
      preflight: true,
      writeAnswer: async () => {},
    },
    relayChecks,
  );
  if (!pre.ok) return { ok: false, reason: pre.reason };
  const human = await getMemberById(ctx.db, binding.member_id);
  const teamRow = await ctx.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [team.id]);
  if (!human || human.kind !== 'human' || !teamRow) return { ok: false, reason: 'binding_stale' };
  const { routeEnvelope } = await import('../protocol/route.js');
  const verdict = answer.decision === 'approve' ? 'accept' : 'decline';
  const routed = await routeEnvelope(
    ctx,
    teamRow,
    human,
    makeEnvelope({
      id: input.messageId,
      team: team.slug,
      from: human.name,
      to: { kind: 'member', name: ask.from_name },
      thread: ask.thread_id ?? ask.id,
      act: verdict,
      body: verdict === 'accept' ? 'Accepted in the musterd app' : 'Rejected in the musterd app',
      meta: { in_reply_to: ask.id, approval: proof },
      ts: now,
    }),
  );
  if (routed.lane_authority_refused)
    return { ok: false, reason: routed.lane_authority_refused.reason };
  const settled = await redeemAskChannelToken(
    ctx.db,
    {
      teamId: team.id,
      token: answer.token,
      askId: ask.id,
      assurance: 'A2',
      decision: answer.decision,
      answerMessageId: input.messageId,
      providerIdentity: {
        tenantId: binding.provider_tenant_id,
        userId: binding.provider_user_id,
      },
      deliveryActor: 'app',
      now,
      writeAnswer: async () => {},
    },
    relayChecks,
  );
  if (!settled.ok) return { ok: false, reason: settled.reason };
  if (input.reported) await auditReported(ctx, team, ask.id, ask.from_name, binding.id);
  await tickVerdictQueue(ctx, team, human, now);
  return { ok: true };
}

async function auditReported(
  ctx: Ctx,
  team: { id: string },
  askId: string,
  askingSeat: string | undefined,
  bindingId: string,
): Promise<void> {
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action: 'channel.answer_reported',
    target: askId,
    result: 'allow',
    detail: { asking_seat: askingSeat ?? 'unknown', binding_id: bindingId },
  });
}

/**
 * The phone's answer to a verdict ask (ADR 694). Its answer signature is already checked; here:
 * 1. The answer must carry an A2 proof by this binding's own phone key — the descriptor signature.
 * 2. Every ADR 623 §6 redemption check, and ADR 662's gate itself, run first in check-only mode,
 *    writing nothing but a refusal's audit row. A refused verdict is never written as an act —
 *    the route would record "Accepted in the musterd app" as a message that moved nothing — and
 *    the token stays live, so the phone can fetch fresh descriptors and try again (lane
 *    01M5DTPMXN: a refused verdict must never answer the ask away).
 * 3. The verdict is performed as the human's own act through `routeEnvelope` — the same door, gate
 *    and lane move as a passkey verdict on /live. There `requireAuthority` verifies the signature
 *    again, for real, and spends the nonce.
 * 4. Only then is the token redeemed, recording the decision against the verdict act's id.
 */
async function answerVerdict(
  ctx: Ctx,
  team: { id: string; slug: string },
  input: {
    binding: ChannelBinding;
    keys: AppKeys;
    key: { id: string };
    ask: AskRow;
    lane: { id: string; title: string };
    answer: AppAnswer;
    messageId: string;
    now: number;
    reported: boolean;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const { binding, answer, ask, now } = input;
  const proof = answer.approval;
  if (!proof) return { ok: false, reason: 'no_signature' };
  if (proof.key_id !== input.key.id) return { ok: false, reason: 'key_revoked' };
  const redeem = (preflight: boolean) =>
    redeemAskChannelToken(
      ctx.db,
      {
        teamId: team.id,
        token: answer.token,
        askId: ask.id,
        assurance: 'A2',
        decision: answer.decision,
        answerMessageId: input.messageId,
        providerIdentity: {
          tenantId: binding.provider_tenant_id,
          userId: binding.provider_user_id,
        },
        deliveryActor: 'app',
        now,
        preflight,
        // The answer IS the verdict act, written by the route below; the decision row names it.
        writeAnswer: async () => {},
      },
      relayChecks,
    );
  const pre = await redeem(true);
  if (!pre.ok) return { ok: false, reason: pre.reason };

  const human = await getMemberById(ctx.db, binding.member_id);
  const teamRow = await ctx.db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [team.id]);
  if (!human || human.kind !== 'human' || !teamRow) return { ok: false, reason: 'binding_stale' };
  const verdict = answer.decision === 'approve' ? 'accept' : 'decline';
  const gate = await requireAuthority(ctx.db, {
    teamId: team.id,
    audience: team.slug,
    presenter: human,
    credential: 'human',
    act: 'human_accept',
    target: input.lane.id,
    payload: verdictPayload(input.lane.id, verdict),
    proof,
    checkOnly: true,
  });
  if (!gate.ok) return { ok: false, reason: gate.reason };
  // The phone's key enrolled, so this is A2 — never the unenrolled Bearer pass.
  if (gate.assurance !== 'A2') return { ok: false, reason: 'no_signature' };
  // Imported here, not at the top: route.ts imports this module to deliver asks, and the
  // verdict is the one place this adapter sends an act of its own.
  const { routeEnvelope } = await import('../protocol/route.js');
  const routed = await routeEnvelope(
    ctx,
    teamRow,
    human,
    makeEnvelope({
      id: input.messageId,
      team: team.slug,
      from: human.name,
      to: { kind: 'member', name: ask.from_name },
      thread: ask.thread_id ?? ask.id,
      act: verdict,
      body:
        verdict === 'accept'
          ? 'Accepted in the musterd app'
          : input.reported
            ? 'Sent back from the musterd app — I did not expect this ask'
            : 'Sent back from the musterd app',
      // `approval` is the proof the route's gate verifies. Not `channel_answer`: this is the
      // human's own verdict, authenticated by their device key, not advice relayed for them.
      meta: { in_reply_to: ask.id, approval: proof },
      ts: now,
    }),
  );
  if (routed.lane_authority_refused) {
    return { ok: false, reason: routed.lane_authority_refused.reason };
  }
  const settled = await redeem(false);
  if (!settled.ok) {
    // The verdict was verified and performed; only the token's bookkeeping lost a race (a second
    // answer from the same delivery). The lane's own guarded write decided which verdict counts.
    log.warn({
      msg: 'away_app_verdict_unsettled',
      team: team.slug,
      ask: ask.id,
      reason: settled.reason,
    });
  }
  if (input.reported) await auditReported(ctx, team, ask.id, ask.from_name, binding.id);
  // The one open verdict is settled: the next in this human's queue may go out (ADR 676 §8).
  await tickVerdictQueue(ctx, team, human, now);
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
  const human = await getMemberById(ctx.db, binding.member_id);
  // Spends the token of a verdict decided elsewhere, so it is not re-sent as if still owed.
  await openVerdicts(ctx, team, binding, now);
  for (const live of await liveAppAsks(ctx, team, binding, now)) {
    await spend(ctx, live.tokenHash, now);
    await deliverOne(ctx, team, link, live.ask, { binding, keys }, live.expiresAt, {
      now,
      waiting: await waitingBehind(ctx, team, human, live.ask.id, now),
    });
  }
  // The phone opened: if no verdict is live on it (expired, or decided elsewhere), the queue moves.
  if (human?.kind === 'human') await tickVerdictQueue(ctx, team, human, now);
  return { ok: true };
}

/**
 * The asks still live on one binding: an unconsumed, unexpired token, no decision, the ask
 * unchanged since the token was issued, and still one the app carries (advisory, or a verdict). `askId` narrows it to one ask.
 */
async function liveAppAsks(
  ctx: Ctx,
  team: { id: string },
  binding: ChannelBinding,
  now: number,
  askId?: string,
): Promise<{ tokenHash: string; ask: AskRow; expiresAt: number }[]> {
  const rows = await ctx.db.all<{
    token_hash: string;
    ask_id: string;
    expires_at: number;
    ask_digest: string;
  }>(
    `SELECT t.token_hash, t.ask_id, t.expires_at, t.ask_digest FROM ask_channel_tokens t
      WHERE t.team_id = ? AND t.binding_id = ? AND t.binding_generation = ?
        AND t.consumed_at IS NULL AND t.expires_at > ?
        ${askId ? 'AND t.ask_id = ?' : ''}
        AND NOT EXISTS (SELECT 1 FROM ask_decisions d WHERE d.team_id = t.team_id AND d.ask_id = t.ask_id)
        AND NOT EXISTS (
          SELECT 1 FROM messages a JOIN members author ON author.id = a.from_member AND author.team_id = a.team_id
           WHERE a.team_id = t.team_id AND a.act IN ('accept', 'decline') AND author.kind = 'human'
             AND json_extract(a.meta, '$.in_reply_to') = t.ask_id
             AND json_extract(a.meta, '$.human_authority_checked') = 1
        )
      ORDER BY t.created_at LIMIT ?`,
    [
      team.id,
      binding.id,
      binding.generation,
      now,
      ...(askId ? [askId] : []),
      askId ? 1 : REDELIVER_MAX,
    ],
  );
  const out: { tokenHash: string; ask: AskRow; expiresAt: number }[] = [];
  for (const row of rows) {
    const ask = await loadAsk(ctx.db, team.id, row.ask_id);
    if (!ask || askDigest(ask.body, ask.meta) !== row.ask_digest) continue;
    if (!appAskKind(parseMeta(ask.meta))) continue;
    out.push({ tokenHash: row.token_hash, ask, expiresAt: row.expires_at });
  }
  return out;
}

/** Spend the token a re-issued delivery replaces, so one live token per ask and binding remains. */
async function spend(ctx: Ctx, tokenHash: string, now: number): Promise<void> {
  await ctx.db.run(
    'UPDATE ask_channel_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL',
    [now, tokenHash],
  );
}

/**
 * The phone fetching a body its push left out (ADR 676 §2). Like a re-delivery of one ask, the
 * delivery is re-issued with a fresh token and the old one is spent: the daemon keeps no sealed
 * body, and the token only ever exists inside a seal. Anything not live on that binding — a
 * stale binding, a decided or expired ask, an unknown ref — answers `null`, saying no more.
 * Whoever asks gets ciphertext only the paired phone can open.
 */
export async function handleAppFetch(
  ctx: Ctx,
  team: { id: string; slug: string },
  frame: Pick<RelayAppFetchFrame, 'ask_ref' | 'binding'>,
  now: number = Date.now(),
): Promise<{ sealed: SealedBodyWire; expires_at: number } | null> {
  const binding = await ctx.db.get<ChannelBinding>(
    `SELECT * FROM channel_bindings WHERE id = ? AND team_id = ? AND channel = ? AND status = 'active'`,
    [frame.binding, team.id, APP_CHANNEL],
  );
  const keys = binding ? await appBindingKeys(ctx.db, team.id, binding.id) : null;
  if (!binding || !keys) return null;
  const [live] = await liveAppAsks(ctx, team, binding, now, frame.ask_ref);
  if (!live) return null;
  await spend(ctx, live.tokenHash, now);
  const human = await getMemberById(ctx.db, binding.member_id);
  const input = await issueAskDelivery(ctx, team, live.ask, { binding, keys }, live.expiresAt, {
    now,
    waiting: await waitingBehind(ctx, team, human, live.ask.id, now),
  });
  const sealed = await sealDelivery(team, input);
  await auditSealed(ctx, team, input, sealed, 'fetched');
  return { sealed, expires_at: live.expiresAt };
}
