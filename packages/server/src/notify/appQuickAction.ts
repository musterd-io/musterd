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
import { listGoals } from '../store/goals.js';
import { listLanes } from '../store/lanes.js';
import { getMemberById, listMembers } from '../store/members.js';
import { readScopeSql } from '../store/messages.js';
import { portraitsOf } from '../store/portraits.js';
import { hasLivePresence } from '../store/presence.js';
import { openQuestions } from '../store/questions.js';
import { getResidency } from '../store/residency.js';
import { messageVisibilityOf } from '../store/rows.js';
import { getTeamBySlug } from '../store/teams.js';
import { rosterPoll } from './appPoll.js';
import { verifyPhoneSigned } from './appQuestion.js';
import { loadAppChannelKeys, openFromPhone } from './appSeal.js';
import {
  appForYou,
  appMembers,
  appMoments,
  liveAsks,
  type ForYouSource,
  type MomentLaneLike,
} from './appTeam.js';

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
  // ADR 807: the team's Twitch poll rides the roster, for an admin's binding only.
  const poll = await rosterPoll(ctx, team.id, binding, now);
  const team814 = await appTeamFor(ctx, team, binding, seats, waiting, now);
  return {
    v: 1,
    kind: 'roster',
    team: team.slug,
    binding: binding.id,
    ts: now,
    seats,
    ...(poll ? { poll } : {}),
    ...team814,
  };
}

/** How far back an open ask is looked for: past any review window a team sets (as appAdapter). */
const OPEN_ASK_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * ADR 814: `members` (the team as /live's column folds it) and `for_you` (what waits on the
 * binding's person). `members` needs the injected roster read; without it, neither field is sent
 * and the phone keeps to `seats`. Open asks are undecided asks to a person or the team in the last
 * week, questions excluded (they are `openQuestions`, listed once as questions).
 */
async function appTeamFor(
  ctx: Ctx,
  team: { id: string; slug: string },
  binding: ChannelBinding,
  seats: { seat: string; wakeable: boolean; portrait?: string | null }[],
  waiting: ReadonlyMap<string, { to: string | null; since: number }>,
  now: number,
): Promise<Pick<Extract<AppDelivery, { kind: 'roster' }>, 'members' | 'for_you' | 'moments'>> {
  if (!ctx.memberSummaries) return {};
  const person = binding.member_id ? await getMemberById(ctx.db, binding.member_id) : null;
  const viewer = person && person.kind === 'human' ? person : null;
  // ADR 407: only the asks this person's /live would show them — the timeline's own read scope, so
  // a confidential ask or another pair's DM never reaches a phone as "asking <name>".
  const scope = readScopeSql({
    grade: viewer ? messageVisibilityOf(viewer) : 'public',
    readerId: viewer?.id ?? '',
  });
  const rows = await ctx.db.all<{
    id: string;
    body: string;
    meta: string | null;
    ts: number;
    to_kind: string;
    to_member: string | null;
    thread_id: string | null;
    from_name: string;
    to_name: string | null;
    to_member_kind: string | null;
  }>(
    `SELECT msg.id, msg.body, msg.meta, msg.ts, msg.to_kind, msg.to_member, msg.thread_id,
            mf.name AS from_name, mt.name AS to_name, mt.kind AS to_member_kind
       FROM (SELECT * FROM messages
              WHERE team_id = ? AND act = 'ask' AND ts > ?${scope.sql}) msg
       JOIN members mf ON mf.id = msg.from_member AND mf.team_id = msg.team_id
       LEFT JOIN members mt ON mt.id = msg.to_member AND mt.team_id = msg.team_id
      WHERE (msg.meta IS NULL OR json_extract(msg.meta, '$.question') IS NULL)
        AND NOT EXISTS (SELECT 1 FROM ask_decisions d WHERE d.team_id = msg.team_id AND d.ask_id = msg.id)
      ORDER BY msg.ts, msg.id`,
    [team.id, now - OPEN_ASK_LOOKBACK_MS, ...scope.params],
  );
  // Every act that can settle an ask in the window, read whole: it only ever closes an ask, so it
  // needs no read scope. /live's rule (appTeam.ts liveAsks) then keeps what is still loud.
  const closers = await ctx.db.all<{
    act: string;
    ts: number;
    thread_id: string | null;
    meta: string | null;
  }>(
    `SELECT act, ts, thread_id, meta FROM messages
      WHERE team_id = ? AND ts > ?
        AND (act IN ('accept', 'decline', 'resolve', 'wait')
             OR json_extract(meta, '$.ask_outcome') IS NOT NULL)`,
    [team.id, now - OPEN_ASK_LOOKBACK_MS],
  );
  const parse = (m: string | null): Record<string, unknown> | null => {
    if (!m) return null;
    try {
      return JSON.parse(m) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const asks = liveAsks(
    rows.map((r) => ({ ...r, thread: r.thread_id, meta: parse(r.meta) })),
    closers.map((c) => ({ act: c.act, ts: c.ts, thread: c.thread_id, meta: parse(c.meta) })),
    now,
  );
  // /live's teamCards: the freshest open ask per asker addressed to a person (or the team).
  const asking = new Map<string, { to: string | null }>();
  for (const a of asks) {
    const toPerson = a.to_kind === 'team' || a.to_member_kind === 'human';
    if (toPerson) asking.set(a.from_name, { to: a.to_kind === 'team' ? null : a.to_name });
  }
  const goals = await listGoals(ctx.db, team.id, team.slug);
  const members = appMembers({
    roster: await ctx.memberSummaries(team, viewer),
    lanes: await listLanes(ctx.db, team.id, team.slug, { states: [...LIVE_LANE_STATES] }),
    goals,
    asking,
    waiting,
    seats: new Map(
      seats.map((s) => [s.seat, { wakeable: s.wakeable, portrait: s.portrait ?? null }] as const),
    ),
    now,
  });
  const moments = await momentsFor(ctx, team, viewer, goals, scope, now);
  if (!viewer) return { members, moments };
  const owed: ForYouSource[] = asks
    .filter((a) => a.to_member === viewer.id || a.to_kind === 'team')
    .map((a) => ({
      id: a.id,
      from: a.from_name,
      kind: a.meta?.['lane_review'] !== undefined ? 'review' : 'approve',
      body: a.body,
      ts: a.ts,
    }));
  for (const q of await openQuestions(ctx.db, team.id, { forPerson: viewer.name }))
    owed.push({ id: q.id, from: q.asker, kind: 'question', body: q.question.text, ts: q.asked_at });
  return { members, for_you: appForYou(owed), moments };
}

function parseMeta(m: string | null): Record<string, unknown> | null {
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * ADR 819: the day's moments, from the daemon's local midnight. Lanes are the board every member
 * sees; acts go through the same read scope as the asks, so a confidential verdict or goal note
 * never becomes another person's moment.
 */
async function momentsFor(
  ctx: Ctx,
  team: { id: string; slug: string },
  viewer: { name: string } | null,
  goals: readonly { id: string; title: string }[],
  scope: { sql: string; params: unknown[] },
  now: number,
) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime();
  const laneRows = await ctx.db.all<{
    id: string;
    title: string;
    owner_seat: string | null;
    goal_id: string | null;
    state: MomentLaneLike['state'];
    claimed_at: number | null;
    resolved_at: number | null;
    requested_json: string | null;
  }>(
    `SELECT id, title, owner_seat, goal_id, state, claimed_at, resolved_at, requested_json
       FROM lanes
      WHERE team_id = ? AND ((state = 'done' AND resolved_at >= ?) OR claimed_at >= ?
             OR state = 'awaiting_acceptance')`,
    [team.id, since, since],
  );
  const closes = await ctx.db.all<{ target: string; detail: string | null }>(
    `SELECT target, detail FROM audit WHERE team_id = ? AND action = 'lane.closed' AND ts >= ?
      ORDER BY ts, id`,
    [team.id, since],
  );
  const verified = new Map<string, boolean>();
  for (const c of closes) {
    const v = (parseMeta(c.detail) ?? {})['verified'];
    if (typeof v === 'boolean') verified.set(c.target, v);
  }
  const lanes: MomentLaneLike[] = laneRows.map((l) => {
    const by = (parseMeta(l.requested_json) ?? {})['by'];
    return {
      ...l,
      claimed_at: l.claimed_at === null ? null : Number(l.claimed_at),
      resolved_at: l.resolved_at === null ? null : Number(l.resolved_at),
      requested_by: typeof by === 'string' ? by : null,
      verified: verified.get(l.id),
    };
  });
  const acts = await ctx.db.all<{
    id: string;
    act: string;
    body: string;
    meta: string | null;
    ts: number;
    to_kind: string;
    from_name: string;
    from_kind: string;
    review_lane: string | null;
  }>(
    `SELECT msg.id, msg.act, msg.body, msg.meta, msg.ts, msg.to_kind,
            mf.name AS from_name, mf.kind AS from_kind,
            json_extract(a.meta, '$.lane_review.lane') AS review_lane
       FROM (SELECT * FROM messages
              WHERE team_id = ? AND ts >= ? AND act IN ('message', 'accept', 'decline')${scope.sql}) msg
       JOIN members mf ON mf.id = msg.from_member AND mf.team_id = msg.team_id
       LEFT JOIN messages a ON a.team_id = msg.team_id AND a.id = msg.in_reply_to AND a.act = 'ask'
      ORDER BY msg.ts DESC, msg.id
      LIMIT 500`,
    [team.id, since, ...scope.params],
  );
  return appMoments({
    lanes,
    goals,
    acts: acts.map((a) => ({
      id: a.id,
      act: a.act,
      from: a.from_name,
      from_kind: a.from_kind,
      ts: Number(a.ts),
      body: a.body,
      meta: parseMeta(a.meta),
      to_kind: a.to_kind,
      review_lane: a.review_lane,
    })),
    since,
    viewer: viewer?.name ?? null,
  });
}
