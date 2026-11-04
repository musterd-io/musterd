import {
  APP_QUICK_ACTION_WINDOW_MS,
  APP_ROSTER_MAX,
  AppQuickActionSchema,
  appQuickActionSigningBytes,
  type AppCallback,
  type AppDelivery,
  type AppQuickAction,
  type QuickActionResult,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { sendSeatQuickAction } from '../protocol/quickActions.js';
import { spendAppQuickActionNonce, type AppKeys } from '../store/appPairing.js';
import { appendAudit } from '../store/audit.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { listLanes } from '../store/lanes.js';
import { getMemberById, listMembers } from '../store/members.js';
import { portraitsOf } from '../store/portraits.js';
import { hasLivePresence } from '../store/presence.js';
import { openQuestions } from '../store/questions.js';
import { getResidency } from '../store/residency.js';
import { getTeamBySlug } from '../store/teams.js';
import { verifyPhoneSigned } from './appQuestion.js';
import { loadAppChannelKeys, openFromPhone } from './appSeal.js';

/**
 * The phone's quick actions and seat roster (ADR 791). A quick action is the same person's `steer`
 * `/live` sends (ADR 779); here it arrives sealed through the relay, signed by the phone's silent
 * question key, and the daemon sends it as the binding's member. Sealing and sending the reply is
 * `appAdapter.ts`'s, so this module imports nothing from it.
 */

type QuickCallback = Extract<AppCallback, { kind: 'quick_action' }>;

/** A roster or result delivery lives this long on the relay. */
export const APP_QUICK_DELIVERY_TTL_MS = 10 * 60_000;
/** The relay ref the phone pulls a roster by (`ts` at or before now) — never pushed. */
export const rosterRef = (ts: number) => `roster-${ts}`;
/** The relay ref of a quick action's result. A result is one seat's word, always small enough to
 *  push, so it is never fetched. */
export const quickResultRef = (nonce: string) => `qa-${nonce}`;

/** Lane states a seat is working in — the one the roster names, as the quick-action line does. */
const LIVE_LANE_STATES = ['claimed', 'active', 'blocked', 'awaiting_acceptance'] as const;

/**
 * Open, check and spend one quick-action callback. Refusals are plain reasons and none says which
 * byte failed. Order matters: every check that can refuse runs before the nonce is spent, so a
 * refused request does not burn a nonce the phone may retry with.
 */
export async function verifyAppQuickAction(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  keys: AppKeys,
  cb: QuickCallback,
  now: number,
): Promise<{ ok: true; action: AppQuickAction } | { ok: false; reason: string }> {
  // The seal binds `expires_at`, so a short window bounds replay in time; the spent nonces close it
  // inside the window.
  if (cb.expires_at <= now || cb.expires_at > now + APP_QUICK_ACTION_WINDOW_MS)
    return { ok: false, reason: 'expired' };
  let opened: Uint8Array;
  try {
    opened = await openFromPhone({
      keys: await loadAppChannelKeys(),
      route: { team: team.slug, binding: binding.id, ref: cb.ref, expires_at: cb.expires_at },
      sealed: cb.sealed,
      purpose: 'quick_action',
    });
  } catch {
    return { ok: false, reason: 'sealed_body' };
  }
  const parsed = (() => {
    try {
      return AppQuickActionSchema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    } catch {
      return null;
    }
  })();
  if (!parsed?.success) return { ok: false, reason: 'bad_request' };
  const action = parsed.data;
  if (action.nonce !== cb.ref) return { ok: false, reason: 'nonce_mismatch' };
  const signed = await verifyPhoneSigned(
    ctx,
    team.id,
    binding,
    keys,
    action.key,
    appQuickActionSigningBytes({
      team: team.slug,
      binding: binding.id,
      seat: action.seat,
      action: action.action,
      nonce: action.nonce,
      ts: action.ts,
    }),
    action.signature,
  );
  if (!signed.ok) return signed;
  const spent = await spendAppQuickActionNonce(ctx.db, team.id, binding.id, action.nonce);
  if (spent !== 'ok') return { ok: false, reason: spent };
  return { ok: true, action };
}

/**
 * Do a verified quick action as the binding's person and say what happened. A seat that is not a
 * standing agent seat refuses the request (`unknown_seat`) before anything is sent.
 */
export async function runAppQuickAction(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  action: AppQuickAction,
  now: number,
): Promise<{ ok: true; result: QuickActionResult } | { ok: false; reason: string }> {
  const person = await getMemberById(ctx.db, binding.member_id);
  const teamRow = await getTeamBySlug(ctx.db, team.slug);
  if (!person || person.kind !== 'human' || person.left_at !== null || !teamRow)
    return { ok: false, reason: 'binding_stale' };
  const result = await sendSeatQuickAction(ctx, teamRow, person, action.seat, action.action, now);
  if (result === null) return { ok: false, reason: 'unknown_seat' };
  await appendAudit(ctx.db, team.id, {
    actor: person.name,
    action: 'app.quick_action',
    target: action.seat,
    result: 'allow',
    detail: { binding_id: binding.id, action: action.action, key: action.key, result },
  });
  return { ok: true, result };
}

/**
 * Rebuild a roster the phone fetches by ref because it was too big to push (ADR 676 §2) — fresh,
 * as of now. Null for any other ref or an expired one.
 */
export async function fetchRoster(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  ref: string,
  now: number,
): Promise<{ delivery: AppDelivery; expiresAt: number } | null> {
  if (!ref.startsWith('roster-')) return null;
  const ts = Number(ref.slice('roster-'.length));
  const expiresAt = ts + APP_QUICK_DELIVERY_TTL_MS;
  if (!Number.isSafeInteger(ts) || ts > now || now >= expiresAt) return null;
  return { delivery: await buildAppRoster(ctx, team, binding, now), expiresAt };
}

/**
 * One member portrait the phone fetches by `portrait-<digest>` (ADR 797) — any digest this team holds,
 * fresh. Null for any other ref or a digest the daemon does not have.
 */
export function fetchPortrait(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  ref: string,
  now: number,
): { delivery: AppDelivery; expiresAt: number } | null {
  if (!ref.startsWith('portrait-')) return null;
  const digest = ref.slice('portrait-'.length);
  const png = portraitsOf(ctx.config.dbPath).get(team.id, digest);
  if (!png) return null;
  return {
    delivery: {
      v: 1,
      kind: 'portrait',
      team: team.slug,
      binding: binding.id,
      digest,
      png: png.toString('base64url'),
    },
    expiresAt: now + APP_QUICK_DELIVERY_TTL_MS,
  };
}

/**
 * The roster delivery (ADR 791): every standing agent seat, whether a session is live in it,
 * whether a host can wake it, and its one live lane (none when it holds zero or several, as the
 * quick-action line reads it). Seats sort by name, so the phone's list does not reshuffle.
 */
export async function buildAppRoster(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  now: number,
): Promise<Extract<AppDelivery, { kind: 'roster' }>> {
  const agents = (await listMembers(ctx.db, team.id))
    .filter((m) => m.kind === 'agent' && m.left_at === null && m.observer === 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, APP_ROSTER_MAX);
  const lanesByOwner = new Map<string, Array<{ id: string; title: string }>>();
  for (const lane of await listLanes(ctx.db, team.id, team.slug, {
    states: [...LIVE_LANE_STATES],
  })) {
    if (!lane.owner_seat) continue;
    const held = lanesByOwner.get(lane.owner_seat) ?? [];
    held.push({ id: lane.id, title: lane.title });
    lanesByOwner.set(lane.owner_seat, held);
  }
  const portraits = portraitsOf(ctx.config.dbPath).digests(team.id);
  // ADR 806: each seat's oldest open question (oldest first, so the first one per asker wins) —
  // the same rule as /live's waitingOn.
  const waiting = new Map<string, { to: string | null; since: number }>();
  for (const q of await openQuestions(ctx.db, team.id))
    if (!waiting.has(q.asker)) waiting.set(q.asker, { to: q.to, since: q.asked_at });
  const seats = [];
  for (const agent of agents) {
    const held = lanesByOwner.get(agent.name) ?? [];
    const residency = await getResidency(ctx.db, team.id, agent.id);
    seats.push({
      seat: agent.name,
      online: await hasLivePresence(ctx.db, agent.id, ctx.config.presenceTimeoutMs),
      wakeable: residency !== null && (agent.halted_at === null || agent.halted_at === undefined),
      lane: held.length === 1 ? held[0]! : null,
      // ADR 797: the phone fetches the picture by this digest and caches it.
      portrait: portraits.get(agent.name) ?? null,
      ...(waiting.has(agent.name) ? { waiting: waiting.get(agent.name)! } : {}),
    });
  }
  return { v: 1, kind: 'roster', team: team.slug, binding: binding.id, ts: now, seats };
}
