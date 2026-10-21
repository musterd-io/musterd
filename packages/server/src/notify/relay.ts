import {
  AppCallbackSchema,
  classifyAskAction,
  makeEnvelope,
  RelayServerFrameSchema,
  type RelayAppBodyFrame,
  type RelayCallbackFrame,
  type RelayDaemonFrame,
  type RelayPending,
} from '@musterd/protocol';
import WebSocket from 'ws';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import {
  askDigest,
  redeemAskChannelToken,
  type AskStanding,
  type BindingAuthorizer,
  type RedemptionChecks,
} from '../store/askChannelTokens.js';
import { channelBindingStanding, recordPairingIdentity } from '../store/channelBindings.js';
import { answerAllowed, getChannelSettings } from '../store/channelSettings.js';
import { insertMessage } from '../store/messages.js';
import { listLiveInstallStates, recordSlackInstall } from '../store/slackInstalls.js';
import { getPolicy, listActiveTeams } from '../store/teams.js';
import { backoffMs } from '../sync/streamJoiner.js';
import { handleAppCallback, handleAppFetch } from './appAdapter.js';
import { parseSlackCallback } from './slackAdapter.js';

/**
 * The daemon's away-relay client (ADR 659): one WebSocket per configured team to its relay
 * Durable Object, reconnect with the sync stream's backoff (ADR 552), and a `reconcile` frame on
 * every open carrying the daemon's live pending set — the relay's rows are a cache, this daemon
 * is the source of truth, so a restart kills every button the daemon no longer stands behind.
 *
 * A team with `away_relay_url` / `away_relay_token` unset (the default) never connects: no
 * outbound call, the ADR 149 posture. Callbacks are forwarded raw by the relay; parsing a
 * provider's payload is its adapter's job (Slack: lane 01M50XQ04M8E3X5QHY173Q18X7). The current
 * route accepts Slack form callbacks only, redeeming them against the token's binding and ask id
 * in the daemon store (ADR 618 §7): no current matching binding or route id, no answer (ADR 623
 * §6). Pairing identity is staged, never bound — binding waits for the human's confirmation on
 * the original surface.
 */

/** How often the client looks for teams whose relay policy appeared, changed, or went away. */
export const AWAY_RELAY_RESCAN_MS = 15_000;

/**
 * `https://relay/…` (or a `wss://` policy URL, which the CLI also accepts) →
 * `wss://relay/teams/<slug>/connect` (ADR 659 §1). Anything else is refused outright: the
 * credential rides this socket as a Bearer [REDACTED], so mapping `http:`/`ws:` to a plaintext
 * socket would send it in cleartext.
 */
export function relaySocketUrl(relayUrl: string, slug: string): URL {
  const url = new URL(`/teams/${encodeURIComponent(slug)}/connect`, relayUrl);
  if (url.protocol === 'https:' || url.protocol === 'wss:') {
    url.protocol = 'wss:';
    return url;
  }
  throw new Error(
    `away relay url must be https: or wss:, got ${url.protocol} — refusing to send the relay credential over a plaintext socket`,
  );
}

/**
 * The daemon's live pending set for one team: one row per ask with an unconsumed, unexpired
 * channel token and no decision yet. The dedupe id is stable per ask+channel, so a re-push after
 * a reconnect is the same delivery, not a second one.
 */
export async function buildRelayPending(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<RelayPending[]> {
  const rows = await db.all<{ ask_id: string; channel: string; expires_at: number }>(
    `SELECT t.ask_id, t.channel, MIN(t.expires_at) AS expires_at
       FROM ask_channel_tokens t
      WHERE t.team_id = ? AND t.consumed_at IS NULL AND t.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM ask_decisions d
                         WHERE d.team_id = t.team_id AND d.ask_id = t.ask_id)
      GROUP BY t.ask_id, t.channel
      ORDER BY t.ask_id, t.channel`,
    [teamId, now],
  );
  const byAsk = new Map<string, RelayPending>();
  for (const row of rows) {
    if (byAsk.has(row.ask_id)) continue;
    byAsk.set(row.ask_id, {
      ask_ref: row.ask_id,
      dedupe_id: `${row.ask_id}:${row.channel}`,
      expires_at: row.expires_at,
    });
  }
  return [...byAsk.values()];
}

/** The ask as it stands NOW, for redemption (ADR 623 §6): open, digest, recomputed class. */
async function relayAskStanding(
  db: Driver,
  teamId: string,
  askId: string,
): Promise<AskStanding | null> {
  const token = await db.get<{ ask_digest: string }>(
    `SELECT ask_digest FROM ask_channel_tokens
      WHERE team_id = ? AND ask_id = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [teamId, askId],
  );
  if (!token) return null;
  const ask = await db.get<{ body: string; meta: string | null }>(
    'SELECT body, meta FROM messages WHERE team_id = ? AND id = ?',
    [teamId, askId],
  );
  if (!ask) return null;
  const decided = await db.get<{ ask_id: string }>(
    'SELECT ask_id FROM ask_decisions WHERE team_id = ? AND ask_id = ?',
    [teamId, askId],
  );
  let meta: Record<string, unknown> | null = null;
  try {
    meta = ask.meta ? (JSON.parse(ask.meta) as Record<string, unknown>) : null;
  } catch {
    meta = null;
  }
  return {
    open: !decided,
    // Recomputed from the stored ask (ADR 668): an ask changed after delivery no longer
    // matches the digest its token was issued against, and redemption refuses it.
    digest: askDigest(ask.body, ask.meta),
    actionClass: classifyAskAction(meta),
  };
}

export const relayChecks: RedemptionChecks = {
  askStanding: relayAskStanding,
  // The pairing lane's binding store (ADR 618 §7): a binding is current only while it is active
  // at the generation the token names; revoked, re-paired or unknown bindings refuse the answer.
  bindingStanding: channelBindingStanding,
  // Channel settings (away channels 6): the binding's human may have turned answering off for
  // this channel (or delivery off, which ends both) — refused as answer_disabled.
  answerEnabled: async (t, teamId, bindingId, channel) => {
    const binding = await t.get<{ member_id: string }>(
      'SELECT member_id FROM channel_bindings WHERE id = ? AND team_id = ?',
      [bindingId, teamId],
    );
    if (!binding) return false;
    return answerAllowed(await getChannelSettings(t, teamId, binding.member_id, channel));
  },
  bindingAuthorizer: async (t, teamId, bindingId, generation, channel) =>
    (await t.get<BindingAuthorizer>(
      // Quoted: Postgres folds an unquoted alias to lower case, and this row is read by its
      // camelCase keys (a PGlite-only binding_stale on every answer, found 2026-10-21).
      `SELECT m.id AS "memberId", m.name AS "memberName", b.channel,
              b.provider_tenant_id AS "providerTenantId",
              b.provider_user_id AS "providerUserId"
         FROM channel_bindings b
         JOIN members m ON m.id = b.member_id AND m.team_id = b.team_id
        WHERE b.id = ? AND b.team_id = ? AND b.generation = ?
          AND b.channel = ? AND b.status = 'active'`,
      [bindingId, teamId, generation, channel],
    )) ?? null,
};

/**
 * Redeem one signed Slack callback. Unsigned JSON callbacks are refused; anything else is the
 * provider adapter's to parse and is reported back unhandled, never guessed at. A redeemed answer
 * is written as a `message` carrying `meta.channel_answer` — never an `accept`/`decline`
 * (ADR 618 §5) — inside the redemption transaction.
 */
export async function handleRelayCallback(
  ctx: Ctx,
  team: { id: string; slug: string },
  frame: RelayCallbackFrame,
  now: number = Date.now(),
): Promise<{ ok: boolean; reason?: string }> {
  // The musterd app (ADR 676): a JSON body with `app: 1`. Its trust is the seal and the phone's
  // signature, checked in the adapter; the relay vouches for nothing.
  const app = parseAppCallback(frame.body);
  if (app) return handleAppCallback(ctx, team, app, now);
  // Treat the whole form as Slack-shaped when it contains a `payload` field, regardless of
  // field order or percent-encoding. The Worker verifies its signature before forwarding.
  const slackBody = new URLSearchParams(frame.body).has('payload') ? frame.body : null;
  if (!slackBody) return { ok: false, reason: 'unparseable_callback' };
  // Pairing callbacks stage provider identity, binding nothing; the human confirms on the
  // original surface. Answer callbacks must match the identity already bound to their token.
  const slack = slackBody ? parseSlackCallback(slackBody) : null;
  if (slackBody && !slack) return { ok: false, reason: 'unparseable_callback' };
  if (slack) {
    if (slack.pairingNonce) {
      const staged = await recordPairingIdentity(ctx.db, {
        nonce: slack.pairingNonce,
        providerTenantId: slack.providerTenantId,
        providerUserId: slack.providerUserId,
        now,
      });
      return staged.ok ? { ok: true } : { ok: false, reason: staged.reason };
    }
    if (!slack.token || !slack.decision) return { ok: false, reason: 'binding_stale' };
    const result = await redeemAskChannelToken(
      ctx.db,
      {
        teamId: team.id,
        token: slack.token,
        askId: frame.ask_ref,
        assurance: 'A1',
        decision: slack.decision,
        answerMessageId: `slack-${frame.ask_ref}-${now}`,
        providerIdentity: { tenantId: slack.providerTenantId, userId: slack.providerUserId },
        deliveryActor: 'slack',
        now,
        writeAnswer: async (t, authorizer) => {
          await insertMessage(
            t,
            team.id,
            authorizer.memberId,
            null,
            makeEnvelope({
              id: `slack-${frame.ask_ref}-${now}`,
              team: team.slug,
              from: authorizer.memberName,
              to: { kind: 'team' },
              act: 'message',
              body: slack.decision === 'approve' ? 'Approved via Slack' : 'Rejected via Slack',
              meta: {
                in_reply_to: frame.ask_ref,
                channel_answer: { channel: 'slack', assurance: 'A1', decision: slack.decision },
              },
              ts: now,
            }),
          );
        },
      },
      relayChecks,
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  return { ok: false, reason: 'unparseable_callback' };
}

/** An app callback body, parsed at the boundary (hard rule 4); null for anything else. */
function parseAppCallback(body: string) {
  if (!body.startsWith('{')) return null;
  try {
    const parsed = AppCallbackSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface RelayLink {
  /** Queue one daemon frame; false when no socket is live (the caller keeps its own retry). */
  send(frame: RelayDaemonFrame): boolean;
  stop(): void;
}

/** Live links per daemon config, so later lanes can deliver through the running client. */
const linksByConfig = new WeakMap<Ctx['config'], Map<string, RelayLink>>();

/** Tests stand in a link for a team without a socket; `null` removes it. */
export function __setRelayLinkForTest(ctx: Ctx, teamSlug: string, link: RelayLink | null): void {
  const map = linksByConfig.get(ctx.config) ?? new Map<string, RelayLink>();
  if (link) map.set(teamSlug, link);
  else map.delete(teamSlug);
  linksByConfig.set(ctx.config, map);
}

/** The live relay link for a team, or null when unconfigured/disconnected (lane 5 delivers here). */
export function relayLinkFor(ctx: Ctx, teamSlug: string): RelayLink | null {
  return linksByConfig.get(ctx.config)?.get(teamSlug) ?? null;
}

/** Start the relay client: one link per team whose policy names a relay. Returns a stop function. */
export function startAwayRelay(ctx: Ctx): () => void {
  const links = new Map<string, { url: string; credential: string; link: RelayLink }>();
  linksByConfig.set(ctx.config, new Map());
  let stopped = false;

  const open = (team: { id: string; slug: string }, url: string, credential: string): RelayLink => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let down = false;
    let closed = false;

    const schedule = () => {
      if (closed || stopped) return;
      timer = setTimeout(connect, backoffMs(attempt));
      if (typeof timer.unref === 'function') timer.unref();
      attempt += 1;
    };

    const connect = () => {
      timer = null;
      if (closed || stopped) return;
      let socketUrl: URL;
      try {
        socketUrl = relaySocketUrl(url, team.slug);
      } catch (err) {
        // A plaintext (or otherwise unusable) policy URL never dials; retry on the scan's cadence
        // in case policy is fixed, but never send the credential over it.
        log.warn({ msg: 'away_relay_bad_url', team: team.slug, err: String(err) });
        schedule();
        return;
      }
      const socket = new WebSocket(socketUrl, {
        headers: { authorization: `Bearer ${credential}` },
        handshakeTimeout: 10_000,
      });
      ws = socket;
      socket.on('open', () => {
        attempt = 0;
        down = false;
        log.info({ msg: 'away_relay_up', team: team.slug });
        // Reconcile on every open: the relay drops whatever this daemon no longer stands behind.
        void buildRelayPending(ctx.db, team.id)
          .then((pending) => {
            socket.send(JSON.stringify({ protocol: 1, type: 'reconcile', pending }));
            // Pick up any Slack install the OAuth flow completed while we were away
            // (ADR 668 decision 2): the relay holds the record until our ack.
            socket.send(JSON.stringify({ protocol: 1, type: 'install_sync' }));
            // Register every live install state we minted (hashes only): the relay
            // accepts a state only from the team whose object holds its hash.
            void listLiveInstallStates(ctx.db, team.id)
              .then((states) => {
                for (const s of states)
                  socket.send(
                    JSON.stringify({
                      protocol: 1,
                      type: 'install_state',
                      state_hash: s.stateHash,
                      destination: s.destination,
                    }),
                  );
              })
              .catch(() => {});
          })
          .catch((err) =>
            log.warn({ msg: 'away_relay_reconcile_failed', team: team.slug, err: String(err) }),
          );
      });
      socket.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        const frame = RelayServerFrameSchema.safeParse(parsed);
        if (!frame.success) return;
        if (frame.data.type === 'delivered') {
          // App deliveries' dedupe ids are `<ask>:app:<binding>` and `<pairing>:paired`.
          const app = /:app:|:paired$/.test(frame.data.dedupe_id);
          log.info({
            msg: app
              ? frame.data.ok
                ? 'away_app_delivered'
                : 'away_app_delivery_failed'
              : frame.data.ok
                ? 'away_slack_delivered'
                : 'away_slack_delivery_failed',
            team: team.slug,
            ask: frame.data.ask_ref,
            status: frame.data.status,
            ...(frame.data.reason ? { reason: frame.data.reason } : {}),
          });
        } else if (frame.data.type === 'callback') {
          void handleRelayCallback(ctx, team, frame.data).then((r) => {
            if (!r.ok && r.reason !== 'unparseable_callback')
              log.info({ msg: 'away_relay_callback_refused', team: team.slug, reason: r.reason });
          });
        } else if (frame.data.type === 'installs') {
          // Each record must match a live install state this daemon minted; the store
          // refuses (and audits) anything else. Ack only what we were handed, stored or
          // refused — either way the relay's copy has served its purpose and is dropped.
          const installs = frame.data.installs;
          void (async () => {
            for (const install of installs) {
              const result = await recordSlackInstall(ctx.db, {
                teamId: team.id,
                actor: 'relay',
                slackTeamId: install.slack_team_id,
                botToken: install.bot_token,
                installerSlackId: install.installer_slack_id,
                state: install.state,
                installedAt: install.installed_at,
              });
              log.info({
                msg: result.ok ? 'away_slack_installed' : 'away_slack_install_refused',
                team: team.slug,
                slack_team: install.slack_team_id,
                ...(result.ok ? {} : { reason: result.reason }),
              });
            }
            socket.send(
              JSON.stringify({
                protocol: 1,
                type: 'install_ack',
                slack_team_ids: installs.map((i) => i.slack_team_id),
              }),
            );
          })().catch((err) =>
            log.warn({ msg: 'away_slack_install_failed', team: team.slug, err: String(err) }),
          );
        } else if (frame.data.type === 'app_fetch') {
          const { request_id: requestId } = frame.data;
          void handleAppFetch(ctx, team, frame.data)
            .catch((err) => {
              log.warn({ msg: 'away_app_fetch_failed', team: team.slug, err: String(err) });
              return null;
            })
            .then((found) => {
              socket.send(
                JSON.stringify({
                  protocol: 1,
                  type: 'app_body',
                  request_id: requestId,
                  sealed: found?.sealed ?? null,
                  ...(found ? { expires_at: found.expires_at } : {}),
                } satisfies RelayAppBodyFrame),
              );
            });
        } else if (frame.data.type === 'error') {
          log.warn({ msg: 'away_relay_frame_refused', team: team.slug, reason: frame.data.reason });
        }
      });
      const lost = (reason: string) => {
        if (ws === socket) ws = null;
        if (closed || stopped) return;
        if (!down) {
          down = true;
          log.warn({ msg: 'away_relay_down', team: team.slug, reason });
        }
        schedule();
      };
      socket.on('close', () => lost('closed'));
      socket.on('error', (error) => {
        if (!down) log.warn({ msg: 'away_relay_error', team: team.slug, error: String(error) });
      });
    };

    connect();
    const link: RelayLink = {
      send(frame) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame));
        return true;
      },
      stop() {
        closed = true;
        if (timer) clearTimeout(timer);
        ws?.terminate();
      },
    };
    return link;
  };

  const scan = async () => {
    if (stopped) return;
    try {
      const teams = await listActiveTeams(ctx.db);
      const wanted = new Set<string>();
      for (const team of teams) {
        const policy = await getPolicy(ctx.db, team.id);
        const url = policy.away_relay_url;
        const credential = policy.away_relay_token;
        if (!url || !credential) continue;
        wanted.add(team.slug);
        const have = links.get(team.slug);
        if (have && have.url === url && have.credential === credential) continue;
        have?.link.stop();
        const link = open(team, url, credential);
        links.set(team.slug, { url, credential, link });
        linksByConfig.get(ctx.config)?.set(team.slug, link);
      }
      for (const [slug, entry] of links) {
        if (!wanted.has(slug)) {
          entry.link.stop();
          links.delete(slug);
          linksByConfig.get(ctx.config)?.delete(slug);
        }
      }
    } catch (error) {
      log.warn({ msg: 'away_relay_scan_failed', error: String(error) });
    }
  };

  void scan();
  const handle = setInterval(() => void scan(), AWAY_RELAY_RESCAN_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => {
    stopped = true;
    clearInterval(handle);
    for (const entry of links.values()) entry.link.stop();
    links.clear();
    linksByConfig.delete(ctx.config);
  };
}
