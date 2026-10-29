import type { AskSkipReason, AskTier, LastAskOutcome } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';

/**
 * Channel settings (spec: Channel settings; away channels 6, lane 01M50XQ5YXXPJ8KVCV31KFB2N8).
 * Per human, per channel, stored in the daemon — and **nothing is on by default**: no row
 * means no delivery and no answer authority. ADR 149's team-level webhook consent does not
 * carry over; each channel is a separate opt-in to a private destination.
 *
 * Each channel has two switches and two dials:
 * - **deliver**: send me asks here.
 * - **answer**: let me answer from here. Turning answer off does not stop delivery (the
 *   message still arrives, buttons inert); turning delivery off also removes answer
 *   authority — a channel that does not deliver to you cannot take answers from you, since
 *   its buttons are how an answer is expressed.
 * - **presence gating** (default on): deliver only when the human is away (ADR 155), so
 *   they are not pinged on their phone while they are at /live.
 * - **tier floor** (optional): deliver only asks at or above this tier.
 */

export interface ChannelSettings {
  channel: string;
  deliver: boolean;
  answer: boolean;
  presenceGating: boolean;
  tierFloor: AskTier | null;
}

export type { AskSkipReason, LastAskOutcome };

const TIER_RANK: Record<AskTier, number> = { advisory: 0, standard: 1, blocking: 2 };

/** Settings for one human and channel; the absent row is the all-off default. */
export async function getChannelSettings(
  db: Driver,
  teamId: string,
  memberId: string,
  channel: string,
): Promise<ChannelSettings> {
  const row = await db.get<{
    deliver_enabled: number;
    answer_enabled: number;
    presence_gating: number;
    tier_floor: string | null;
  }>(
    `SELECT deliver_enabled, answer_enabled, presence_gating, tier_floor
       FROM member_channel_settings
      WHERE team_id = ? AND member_id = ? AND channel = ?`,
    [teamId, memberId, channel],
  );
  if (!row) {
    return { channel, deliver: false, answer: false, presenceGating: true, tierFloor: null };
  }
  return {
    channel,
    deliver: row.deliver_enabled === 1,
    answer: row.answer_enabled === 1,
    presenceGating: row.presence_gating === 1,
    tierFloor: (row.tier_floor as AskTier | null) ?? null,
  };
}

/**
 * Every channel the human has touched, with the all-off default applied per channel, and what
 * became of the last ask on each (`lastAsk`, null when none was routed there yet).
 */
export async function listChannelSettings(
  db: Driver,
  teamId: string,
  memberId: string,
  channels: string[],
): Promise<(ChannelSettings & { lastAsk: LastAskOutcome | null })[]> {
  const member = await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [
    memberId,
  ]);
  return Promise.all(
    channels.map(async (c) => ({
      ...(await getChannelSettings(db, teamId, memberId, c)),
      lastAsk: member ? await lastAskOutcome(db, teamId, member.name, c) : null,
    })),
  );
}

/** The latest `channel.ask_outcome` row for this human on this channel. */
export async function lastAskOutcome(
  db: Driver,
  teamId: string,
  human: string,
  channel: string,
): Promise<LastAskOutcome | null> {
  const rows = await db.all<{ ts: number; detail: string | null }>(
    `SELECT ts, detail FROM audit
      WHERE team_id = ? AND action = 'channel.ask_outcome' AND target = ?
      ORDER BY ts DESC, id DESC LIMIT 20`,
    [teamId, human],
  );
  for (const row of rows) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d['channel'] !== channel || typeof d['ask'] !== 'string') continue;
    return {
      at: Number(row.ts),
      ask: d['ask'],
      outcome: d['outcome'] as LastAskOutcome['outcome'],
      reason: (d['reason'] as AskSkipReason | undefined) ?? null,
    };
  }
  return null;
}

/** Record what became of one ask on one human's channel (lane 01M64DSKT3). */
export async function recordAskOutcome(
  db: Driver,
  input: {
    teamId: string;
    human: string;
    channel: string;
    ask: string;
    outcome: LastAskOutcome['outcome'];
    reason?: AskSkipReason;
  },
): Promise<void> {
  await appendAudit(db, input.teamId, {
    actor: null,
    action: 'channel.ask_outcome',
    target: input.human,
    result: input.outcome === 'sent' ? 'allow' : 'deny',
    detail: {
      channel: input.channel,
      ask: input.ask,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

/** Why these switches would not deliver an ask of this tier, or null when they would. */
export function deliverRefusal(s: ChannelSettings, askTier: AskTier): AskSkipReason | null {
  if (!s.deliver) return 'delivery_off';
  if (s.tierFloor !== null && TIER_RANK[askTier] < TIER_RANK[s.tierFloor])
    return 'below_tier_floor';
  return null;
}

/** Replace one channel's settings (the human's own write, audited as channel.settings.changed). */
export async function setChannelSettings(
  db: Driver,
  input: {
    teamId: string;
    memberId: string;
    actor: string;
    settings: ChannelSettings;
    now?: number;
  },
): Promise<ChannelSettings> {
  const now = input.now ?? Date.now();
  const s = input.settings;
  await db.tx(async (t) => {
    await t.run(
      `INSERT INTO member_channel_settings
         (team_id, member_id, channel, deliver_enabled, answer_enabled, presence_gating,
          tier_floor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, member_id, channel) DO UPDATE SET
         deliver_enabled = excluded.deliver_enabled,
         answer_enabled = excluded.answer_enabled,
         presence_gating = excluded.presence_gating,
         tier_floor = excluded.tier_floor,
         updated_at = excluded.updated_at`,
      [
        input.teamId,
        input.memberId,
        s.channel,
        s.deliver ? 1 : 0,
        s.answer ? 1 : 0,
        s.presenceGating ? 1 : 0,
        s.tierFloor,
        now,
      ],
    );
    await appendAudit(t, input.teamId, {
      actor: input.actor,
      action: 'channel.settings.changed',
      target: s.channel,
      result: 'allow',
      detail: {
        channel: s.channel,
        deliver: s.deliver,
        answer: s.answer,
        presence_gating: s.presenceGating,
        tier_floor: s.tierFloor,
      },
    });
  });
  return s;
}

/** May this channel deliver to this human now? (Switches only; presence is the caller's read.) */
export function deliverAllowed(s: ChannelSettings, askTier: AskTier): boolean {
  if (!s.deliver) return false;
  if (s.tierFloor !== null && TIER_RANK[askTier] < TIER_RANK[s.tierFloor]) return false;
  return true;
}

/** May this human answer from this channel? Answer off keeps delivery; delivery off ends both. */
export function answerAllowed(s: ChannelSettings): boolean {
  return s.deliver && s.answer;
}
