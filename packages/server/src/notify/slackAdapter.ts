import {
  askContract,
  AskTierSchema,
  classifyAskAction,
  type Envelope,
  type RelayDeliverFrame,
} from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { askDigest, issueAskChannelToken } from '../store/askChannelTokens.js';
import { listBindings } from '../store/channelBindings.js';
import { deliverAllowed, getChannelSettings } from '../store/channelSettings.js';
import { listMembers } from '../store/members.js';
import { humanPresent } from '../store/reachability.js';
import { resolveCapabilities, type TeamRow } from '../store/rows.js';
import { getSlackInstallBotToken } from '../store/slackInstalls.js';
import { getPolicy } from '../store/teams.js';
import { relayLinkFor } from './relay.js';

/**
 * The Slack adapter (ADR 668): the first away-channel provider. It does the spec's three
 * adapter things — **deliver** renders one advisory ask as a Slack interactive message,
 * **parse** turns a forwarded Slack callback into `{provider identity, token, decision}`, and
 * **proveIdentity** turns a pairing callback into the identity pairing stages. Slack's
 * signature is verified at the relay Worker (the signing secret never reaches the daemon);
 * what arrives here is ingress-attested transport, and the daemon still trusts nothing in it:
 * the token's binding supplies the authorizer, the payload identity must match that binding, and
 * redemption (ADR 623 §6) re-checks token, digest, class and binding generation.
 */

export const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

/** What a forwarded Slack interactivity payload means, parsed at the boundary. */
export interface SlackCallback {
  providerTenantId: string;
  providerUserId: string;
  /** The ask token from the button value, for an answer. */
  token?: string;
  decision?: 'approve' | 'reject';
  /** The pairing nonce from the button value, for a pairing callback. */
  pairingNonce?: string;
}

/**
 * Parse a Slack interactivity body (`payload=<urlencoded JSON>`, forwarded raw by the relay).
 * Anything that is not exactly that shape is null — the caller reports it unparseable and
 * nothing is guessed at.
 */
export function parseSlackCallback(rawBody: string): SlackCallback | null {
  let payloadJson: string | null = null;
  try {
    payloadJson = new URLSearchParams(rawBody).get('payload');
  } catch {
    return null;
  }
  if (!payloadJson) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    team?: { id?: unknown };
    user?: { id?: unknown };
    actions?: { action_id?: unknown; value?: unknown }[];
  };
  const tenantId = p.team?.id;
  const userId = p.user?.id;
  if (typeof tenantId !== 'string' || typeof userId !== 'string') return null;
  const action = Array.isArray(p.actions) ? p.actions[0] : undefined;
  const value = typeof action?.value === 'string' ? action.value : '';
  // A pairing button carries the nonce as a small JSON value; an answer button carries the
  // bare ask token. The two are told apart by shape, never by the action id alone.
  if (value.startsWith('{')) {
    try {
      const v = JSON.parse(value) as { pairing_nonce?: unknown };
      if (typeof v.pairing_nonce === 'string') {
        return {
          providerTenantId: tenantId,
          providerUserId: userId,
          pairingNonce: v.pairing_nonce,
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  const actionId = typeof action?.action_id === 'string' ? action.action_id : '';
  const decision =
    actionId === 'musterd_approve' ? 'approve' : actionId === 'musterd_reject' ? 'reject' : null;
  if (!decision || !value) return null;
  return { providerTenantId: tenantId, providerUserId: userId, token: value, decision };
}

/** The Slack message for one ask: the ask text, with Approve/Reject buttons carrying the token. */
export function renderSlackDelivery(input: {
  channelUserId: string;
  teamSlug: string;
  from: string;
  body: string;
  token: string;
}): { url: string; headers: Record<string, string>; body: string } {
  const text = `[${input.teamSlug}] ${input.from} asks: ${input.body}`.trim();
  return {
    url: SLACK_POST_URL,
    headers: {},
    body: JSON.stringify({
      channel: input.channelUserId,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: 'musterd_approve',
              value: input.token,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              action_id: 'musterd_reject',
              value: input.token,
            },
          ],
        },
      ],
    }),
  };
}

/** The humans an ask is delivered to: its named recipient, or the team's admin humans. */
async function askHumans(ctx: Ctx, team: TeamRow, env: Envelope) {
  const members = await listMembers(ctx.db, team.id);
  const humans = members.filter((m) => m.kind === 'human');
  if (env.to.kind === 'member') {
    const name = env.to.name;
    return humans.filter((m) => m.name === name);
  }
  return humans.filter((m) => resolveCapabilities(m).is_admin);
}

/**
 * Deliver one routed ask to each addressed human's Slack binding (ADR 668 §4). Detached by
 * the caller: a missing relay, a missing bot token, or a failed hand-off is logged and the ask
 * itself is untouched (its durable reach is the inbox and /live, ADR 147). Privileged asks get
 * no token and no buttons (ADR 618 §4).
 */
export async function deliverAskToSlackChannels(
  ctx: Ctx,
  team: TeamRow,
  env: Envelope,
): Promise<void> {
  try {
    if (env.act !== 'ask') return;
    if (classifyAskAction(env.meta ?? null) !== 'advisory') return;
    const policy = await getPolicy(ctx.db, team.id);
    // The per-install token is the distributed app's credential (ADR 668 decision 5);
    // the team-policy token remains the pre-install fallback until its retirement change.
    const botToken =
      (await getSlackInstallBotToken(ctx.db, team.id))?.botToken ?? policy.slack_bot_token;
    if (!botToken) return;
    const link = relayLinkFor(ctx, team.slug);
    if (!link) return;
    const ask = await ctx.db.get<{ body: string; meta: string | null }>(
      'SELECT body, meta FROM messages WHERE team_id = ? AND id = ?',
      [team.id, env.id],
    );
    if (!ask) return;
    const tierParsed = AskTierSchema.safeParse((env.meta as { tier?: unknown } | undefined)?.tier);
    const askTier = tierParsed.success ? tierParsed.data : 'standard';
    const expiresAt = env.ts + askContract(askTier).timeout_ms;
    for (const human of await askHumans(ctx, team, env)) {
      // Channel settings (away channels 6): nothing is on by default, delivery respects the
      // tier floor, and presence gating (default on) keeps the phone quiet while the human
      // is at /live.
      const settings = await getChannelSettings(ctx.db, team.id, human.id, 'slack');
      if (!deliverAllowed(settings, askTier)) continue;
      if (
        settings.presenceGating &&
        (await humanPresent(ctx.db, team.id, human, ctx.config.presenceTimeoutMs))
      ) {
        continue;
      }
      const binding = (await listBindings(ctx.db, team.id, human.id)).find(
        (b) => b.channel === 'slack' && b.status === 'active',
      );
      if (!binding) continue;
      const { token } = await issueAskChannelToken(ctx.db, {
        teamId: team.id,
        askId: env.id,
        askDigest: askDigest(ask.body, ask.meta),
        actionClass: 'advisory',
        channel: 'slack',
        bindingId: binding.id,
        bindingGeneration: binding.generation,
        requiredAssurance: 'A1',
        expiresAt,
        now: Date.now(),
      });
      const rendered = renderSlackDelivery({
        channelUserId: binding.provider_user_id,
        teamSlug: team.slug,
        from: env.from,
        body: ask.body,
        token,
      });
      const frame: RelayDeliverFrame = {
        protocol: 1,
        type: 'deliver',
        ask_ref: env.id,
        dedupe_id: `${env.id}:slack:${binding.id}`,
        expires_at: expiresAt,
        post: {
          url: rendered.url,
          headers: { authorization: `Bearer ${botToken}` },
          body: rendered.body,
        },
      };
      const sent = link.send(frame);
      log.info({
        msg: sent ? 'away_slack_deliver_queued' : 'away_slack_delivery_failed',
        team: team.slug,
        ask: env.id,
        reason: sent ? undefined : 'relay_not_connected',
      });
    }
  } catch (err) {
    log.warn({ msg: 'away_slack_delivery_failed', team: team.slug, ask: env.id, err: String(err) });
  }
}
