import type { IncomingMessage } from 'node:http';
import {
  WSClientFrame,
  PROTOCOL_VERSION,
  type WSServerFrame,
  type ClaimTarget,
  type Hearing,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { replaySource } from '../cloud/affinity.js';
import { hostTeam } from '../cloud/hostIsolation.js';
import { checkUpgrade } from '../config.js';
import { operatorCtx, teamCtx, type Ctx } from '../context.js';
import { MusterdError, asMusterdError } from '../errors.js';
import { log } from '../log.js';
import { routeEnvelope } from '../protocol/route.js';
import { parseEnvelope } from '../protocol/validate.js';
import { appendAudit } from '../store/audit.js';
import { ownLeaseCreatedAt, settleProvenance } from '../store/dream.js';
import { consumeGrant, refreshGrant, validateGrant } from '../store/grants.js';
import {
  agentKeyMayOccupy,
  agentKeySeatKindRefusal,
  getMemberById,
  getMemberByName,
  hashToken,
  isHeld,
  markBound,
  mintAgentSeatCredential,
  haltedSentence,
} from '../store/members.js';
import { memoryEnvelope } from '../store/memory.js';
import {
  attach,
  recordClaimAttestation,
  attendedSessionRows,
  clearOrphanPresence,
  clearPresenceById,
  hasLivePresence,
  heartbeat,
  presenceById,
  reattestGuidanceEpoch,
  reattestStyleEpoch,
  reattestModel,
  reattestSurface,
  release,
  describeDisplaced,
  type DisplacedSession,
  supersededMessage,
} from '../store/presence.js';
import { createRequest } from '../store/requests.js';
import { getRoleCharter } from '../store/roles.js';
import {
  messageVisibilityOf,
  resolveAccountStatus,
  resolveCapabilities,
  toMember,
} from '../store/rows.js';
import {
  AGENT_SESSION_LEASE_RENEW_AHEAD_MS,
  mintSessionLease,
  sessionLeaseDueForRenewal,
} from '../store/session-leases.js';
import { styleDriverFor, styleEnvelopeFor } from '../store/style.js';
import {
  findBootstrapCredential,
  bootstrapRefusal,
  findBootstrapCredentialRecord,
  getAgentKeyHash,
  getPolicy,
  recordBootstrapCredentialUse,
  requireTeam,
} from '../store/teams.js';
import { isSyncStreamPath } from '../sync/streamHub.js';
import { recordError, recordPresenceChurn } from '../telemetry.js';
import { isReloadOf, type Connection } from './hub.js';

/** Encode a ClaimTarget to the requests table's single-string format. */
function encodeTarget(t: ClaimTarget): string {
  if ('seat' in t) return `seat:${t.seat}`;
  if ('role' in t) return `role:${t.role}`;
  return 'observe';
}

/** Return claimable seat names for the refused frame hint (ADR 055 no-dead-end rule). */
async function claimableSeats(ctx: Ctx, teamId: string): Promise<string[]> {
  return (
    await ctx.db.all<{ name: string }>(
      "SELECT name FROM members WHERE team_id = ? AND left_at IS NULL AND kind = 'agent' AND observer = 0 ORDER BY name",
      [teamId],
    )
  ).map((r) => r.name);
}

interface ConnState {
  connId: string;
  authenticated: boolean;
  conn?: Connection;
  /** Pending same-workspace-predecessor reap this (successor) connection scheduled (ADR 092). Cleared
   * on close so a successor that drops within the grace never reaps on behalf of a dead session. */
  evictionTimer?: NodeJS.Timeout;
  /** The agent session lease this connection's Presence currently backs (ADR 337/347): renewed over
   * the socket before it expires, so a long-lived adapter never presents a dead one. Absent on human
   * and observer connections, which carry no HTTP lease. */
  lease?: { id: string };
  /** ADR 558: the last `hearing` this connection's heartbeat carried, so only a change writes the
   *  `presence.hearing` row — a reconnect re-reports once, a steady state writes nothing. */
  hearing?: Hearing;
  /** When the socket opened, so `ws_close` can say how long it lived. */
  openedAt: number;
  /** What the `close` event carried, read back by the `ws_close` line (lane 01M4VAWG30). A 1006
   *  here means the TCP stream ended with no close frame — the proxy or the network, not either
   *  peer's `close()`; a code either peer sent names that peer. Runs 35/36 lost 23–46 viewer
   *  sockets to bursts of 1006 and the hub's log could not say which side had closed. */
  closeCode?: number;
  closeReason?: string;
  closeError?: string;
}

/**
 * ADR 092: a same-workspace successor does not supersede at claim time (ADR 068 keeps the seat from
 * flapping under transient health-check probes), but once it proves **durable** — still attached
 * after a grace window — it reaps the same-workspace predecessor(s) it found, i.e. the orphaned
 * pre-reload sessions the issue #118 war was between. A transient probe disconnects before the grace,
 * so the gate finds the successor gone and keeps the incumbent untouched. Returns the timer so the
 * successor's own close can cancel it. No-op when there were no same-workspace predecessors.
 */
async function scheduleSameWorkspaceEviction(
  ctx: Ctx,
  teamId: string,
  successorConnId: string,
  memberName: string,
  predecessorConnIds: string[],
): Promise<NodeJS.Timeout | undefined> {
  if (predecessorConnIds.length === 0) return undefined;
  // Drift signal (ADR 092 §C): the duplicate same-workspace adapter is observable in the audit log
  // now, even before — or if — the eviction fires.
  await appendAudit(ctx.db, teamId, {
    actor: memberName,
    action: 'claim.duplicate_workspace',
    target: memberName,
    result: 'allow',
    detail: { predecessors: predecessorConnIds.length, grace_ms: ctx.config.supersedeGraceMs },
  });
  const reap = async () => {
    // Reap only if the successor is still attached — a probe that disconnected within the grace never
    // reaches here (its conn is gone), so the incumbent is preserved (ADR 068's anti-flap intact).
    if (!ctx.hub.getConn(successorConnId)) return;
    let evicted = 0;
    const displacedSessions: DisplacedSession[] = [];
    for (const connId of predecessorConnIds) {
      const old = ctx.hub.getConn(connId);
      if (!old) continue; // predecessor already left on its own
      const was = await describeDisplaced(ctx.db, old.presenceId);
      if (was) displacedSessions.push(was);
      old.send?.({
        type: 'error',
        code: 'superseded',
        message: `your session as "${memberName}" was replaced by a newer one in the same workspace`,
        same_workspace: true,
      });
      old.close?.();
      ctx.hub.remove(old.connId);
      await clearPresenceById(ctx.db, old.presenceId);
      evicted++;
    }
    if (evicted > 0) {
      await appendAudit(ctx.db, teamId, {
        actor: memberName,
        action: 'claim.superseded',
        target: memberName,
        result: 'allow',
        detail: {
          same_workspace: true,
          evicted,
          successor_surface: ctx.hub.getConn(successorConnId)?.surface ?? null,
          displaced: displacedSessions,
        },
      });
    }
  };
  // A timer has no caller to hand a rejection to: on Postgres a store call can reject (a pool
  // timeout, an outage), and an unhandled rejection exits the server (lane 01M3ZC3EXN). The
  // predecessor's row is already detached from the hub; the reaper clears it on its next pass.
  const timer = setTimeout(() => {
    reap().catch((err: unknown) =>
      log.warn({ msg: 'ws_supersede_failed', member: memberName, err: String(err) }),
    );
  }, ctx.config.supersedeGraceMs);
  timer.unref?.();
  return timer;
}

function send(ws: WebSocket, frame: WSServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** Emit a presence event to the team if the member just went online/offline. */
function emitPresence(
  ctx: Ctx,
  conn: Connection,
  status: 'online' | 'offline',
  surface?: string,
): void {
  ctx.hub.broadcastTeam(
    conn.teamId,
    {
      type: 'presence',
      member: conn.memberName,
      status,
      ...(surface ? { surface: surface as never } : {}),
    },
    undefined,
  );
}

export function attachWsServer(rootCtx: Ctx, server: import('node:http').Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  // Spec §12.1: a connection is operator-scoped only long enough to resolve the claim frame's team;
  // from the claim on, its ctx is that team's (below). On SQLite every handle is the same one.
  const opCtx = operatorCtx(rootCtx);

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // ADR 552: the node-to-node sync stream upgrades on its own path, handled by attachSyncStream.
    if (isSyncStreamPath(url.pathname)) return;
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Origin/Host gate (ADR 040): blunt cross-site / DNS-rebinding abuse of a now-exposed daemon.
    const check = checkUpgrade(
      { host: req.headers.host, origin: req.headers.origin },
      {
        boundHost: rootCtx.config.host,
        allowedHosts: rootCtx.config.allowedHosts,
        allowedOrigins: rootCtx.config.allowedOrigins,
        hostSuffix: rootCtx.config.cloud?.hostSuffix ?? null,
      },
    );
    if (!check.ok) {
      log.warn({ msg: 'ws_upgrade_rejected', reason: check.reason });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // ADR 608: the socket belongs on the team's owner. The upgrade is an HTTP request to the proxy
    // like any other, so the same `fly-replay` answer moves it there.
    if (rootCtx.config.cloud && rootCtx.affinity) {
      const team = hostTeam(req.headers.host, rootCtx.config.cloud.hostSuffix);
      const d = rootCtx.affinity.decide(team, replaySource(req.headers['fly-replay-src']));
      if (!d.local && d.owner) {
        socket.write(
          `HTTP/1.1 307 Temporary Redirect\r\nfly-replay: instance=${d.owner}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws: WebSocket, upgrade: IncomingMessage) => {
    // Cloud (spec §5.3): the team this connection's host names; a claim may name no other.
    const cloudSuffix = rootCtx.config.cloud?.hostSuffix ?? null;
    const hostTeamName = cloudSuffix ? hostTeam(upgrade.headers.host, cloudSuffix) : null;
    const state: ConnState = { connId: ulid(), authenticated: false, openedAt: Date.now() };
    // The connection's ctx: operator until the claim names a team, that team's from then on.
    let ctx: Ctx = opCtx;

    // Plan 1A: the frame handler is async (store calls await), so a per-connection chain keeps one
    // socket's frames in arrival order — the synchronous handler serialised them for free before.
    const handleMessage = async (data: RawData): Promise<void> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send(ws, new MusterdError('bad_request', 'invalid JSON frame').toFrame());
        return;
      }
      const frameResult = WSClientFrame.safeParse(parsed);
      if (!frameResult.success) {
        send(ws, new MusterdError('bad_request', 'unknown or malformed frame').toFrame());
        return;
      }
      const frame = frameResult.data;

      try {
        // P3.2 claim frame (ADR 077): governed successor to hello. Authenticates with the team agent
        // key (harness) or a human credential, optionally with a pre-issued grant. Without a grant the
        // server opens a claim request and holds this WS open until an admin decides (spec-gap 3).
        if (frame.type === 'claim') {
          if (frame.v !== PROTOCOL_VERSION) {
            throw new MusterdError('version_mismatch', `server speaks ${PROTOCOL_VERSION}`);
          }
          // Same refusal as an unknown team, so the host cannot probe which teams exist.
          if (cloudSuffix && hostTeamName !== frame.team.toLowerCase())
            throw new MusterdError('not_found', `no team "${frame.team}"`);
          // ADR 608: a socket opened here before the team's owner changed claims against a team
          // this server no longer owns. Close it (1012, service restart) so the client reconnects
          // and the proxy replays the upgrade to the owner — never serve a team from two servers.
          if (rootCtx.affinity && !rootCtx.affinity.decide(frame.team.toLowerCase(), false).local) {
            ws.close(1012, 'team moved');
            return;
          }
          const team = await requireTeam(ctx.db, frame.team);
          ctx = teamCtx(rootCtx, team.id);

          // Step 1: authenticate the bootstrap key or a self-identifying seat credential. An agent
          // seat credential is accepted only to reconnect through this claim handshake (ADR 337).
          let authenticatedAs: import('../store/rows.js').MemberRow | null = null;
          const bootstrapCredential = await findBootstrapCredential(ctx.db, team.id, frame.key);
          const bootstrapRecord =
            bootstrapCredential ??
            (await findBootstrapCredentialRecord(ctx.db, team.id, frame.key));
          if (bootstrapRecord && !bootstrapCredential) {
            const expired =
              bootstrapRecord.expires_at !== null && bootstrapRecord.expires_at <= Date.now();
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: expired ? 'bootstrap_credential.expired' : 'bootstrap_credential.refused',
              target: bootstrapRecord.id,
              result: 'deny',
              detail: {
                reason: expired ? 'expired' : bootstrapRecord.state,
                target: bootstrapRecord.target,
              },
            });
            const refusal = bootstrapRefusal(bootstrapRecord, {
              expired,
              retiredLegacy:
                bootstrapRecord.use_kind === 'legacy' && team.bootstrap_cutover_at !== null,
            });
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: refusal.message,
              claimable: [],
              hint: refusal.hint,
            });
            return;
          }
          const keyHash = await getAgentKeyHash(ctx.db, team.id);
          if (bootstrapCredential || (keyHash && hashToken(frame.key) === keyHash)) {
            // Agent harness: key validates against the team secret. No specific member identity yet.
          } else {
            // Human credential: look up by hash.
            const credHash = hashToken(frame.key);
            authenticatedAs =
              (await ctx.db.get<import('../store/rows.js').MemberRow>(
                "SELECT * FROM members WHERE team_id = ? AND credential_hash = ? AND left_at IS NULL AND kind IN ('human', 'agent')",
                [team.id, credHash],
              )) ?? null;
            if (!authenticatedAs) {
              const claimable = await claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message:
                  'invalid key — present a valid agent key, agent-seat credential, or human credential',
                claimable,
                hint: `musterd claim <seat> --key <mskey_...|msac_...>`,
              });
              await appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: null,
                result: 'deny',
                detail: { code: 'forbidden', reason: 'invalid_key' },
              });
              return;
            }
          }

          // Step 2: resolve the target member.
          let targetMember: import('../store/rows.js').MemberRow | null = null;
          if ('seat' in frame.target) {
            targetMember = (await getMemberByName(ctx.db, team.id, frame.target.seat)) ?? null;
            if (!targetMember || targetMember.left_at !== null) {
              const claimable = await claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'not_found',
                message: `no seat "${frame.target.seat}" in team "${team.slug}"`,
                claimable,
                hint: claimable.length
                  ? `available: ${claimable.join(', ')}`
                  : `musterd team add <seat> --team ${team.slug}`,
              });
              await appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: frame.target.seat,
                result: 'deny',
                detail: { code: 'not_found' },
              });
              return;
            }
            // Human credential must match the target seat.
            if (authenticatedAs && authenticatedAs.id !== targetMember.id) {
              const claimable = [authenticatedAs.name];
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message: `credential identifies "${authenticatedAs.name}", not "${frame.target.seat}"`,
                claimable,
                hint: `musterd claim ${authenticatedAs.name} --key <mscr_...>`,
              });
              return;
            }
          } else if ('role' in frame.target) {
            targetMember =
              (await ctx.db.get<import('../store/rows.js').MemberRow>(
                'SELECT * FROM members WHERE team_id = ? AND role = ? AND left_at IS NULL LIMIT 1',
                [team.id, frame.target.role],
              )) ?? null;
            if (!targetMember) {
              const claimable = await claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'not_found',
                message: `no seats with role "${frame.target.role}" in team "${team.slug}"`,
                claimable,
                hint: claimable.length
                  ? `available seats: ${claimable.join(', ')}`
                  : `musterd team add <seat> --role ${frame.target.role} --team ${team.slug}`,
              });
              await appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: frame.target.role,
                result: 'deny',
                detail: { code: 'not_found', kind: 'role' },
              });
              return;
            }
          }
          // observe: no target member — observer provisioned below in the OCCUPY path

          // Step 2b: SECURITY — the shared team agent key may only occupy an AGENT seat. Same rule,
          // same wording and same position as the HTTP claim path: AFTER target resolution (a `role`
          // target can resolve to a human seat) and BEFORE the grant/request branches, so no admin is
          // ever asked to approve a poisoned claim. `authenticatedAs === null` is the agent-key
          // branch; a human credential already proved it identifies the target seat above. This
          // covers BOTH claim branches below — only the ADR 146 re-seat path checked before.
          if (authenticatedAs === null && targetMember && !agentKeyMayOccupy(targetMember)) {
            const refusal = agentKeySeatKindRefusal(targetMember.name, targetMember.kind);
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: refusal.message,
              claimable: [],
              hint: refusal.hint,
            });
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'claim.refused',
              target: targetMember.name,
              result: 'deny',
              detail: { code: 'forbidden', reason: 'agent_key_human_seat' },
            });
            return;
          }

          if (
            bootstrapCredential?.use_kind === 'claim_seat' &&
            (!('seat' in frame.target) ||
              frame.target.seat !== bootstrapCredential.target ||
              targetMember?.name !== bootstrapCredential.target)
          ) {
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'bootstrap_credential.refused',
              target: bootstrapCredential.id,
              result: 'deny',
              detail: { reason: 'target_mismatch', target: bootstrapCredential.target },
            });
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: `this bootstrap credential may only claim seat "${bootstrapCredential.target}"`,
              claimable: [],
              hint: `musterd claim ${bootstrapCredential.target}`,
            });
            return;
          }
          if (
            bootstrapCredential?.use_kind === 'claim_role' &&
            (!('role' in frame.target) || frame.target.role !== bootstrapCredential.target)
          ) {
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'bootstrap_credential.refused',
              target: bootstrapCredential.id,
              result: 'deny',
              detail: { reason: 'target_mismatch', target: bootstrapCredential.target },
            });
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: `this bootstrap credential may only claim role "${bootstrapCredential.target}"`,
              claimable: [],
              hint: `musterd claim --role ${bootstrapCredential.target}`,
            });
            return;
          }
          if (bootstrapCredential?.use_kind === 'host') {
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'bootstrap_credential.refused',
              target: bootstrapCredential.id,
              result: 'deny',
              detail: { reason: 'claim_with_host_credential', target: bootstrapCredential.target },
            });
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: 'a host bootstrap credential cannot claim a seat',
              claimable: [],
              hint: 'use the residency host endpoints with this credential',
            });
            return;
          }
          if (bootstrapCredential) {
            await recordBootstrapCredentialUse(ctx.db, bootstrapCredential.id);
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'bootstrap_credential.used',
              target: bootstrapCredential.id,
              result: 'allow',
              detail: { use: bootstrapCredential.use_kind, target: bootstrapCredential.target },
            });
          }

          // Step 3: account_status check on target member. ADR 501 first: a halt is the more
          // recent fact and names the human to ask.
          if (
            targetMember &&
            targetMember.halted_at !== null &&
            targetMember.halted_at !== undefined
          ) {
            send(ws, {
              type: 'refused',
              code: 'halted',
              message: haltedSentence(targetMember),
              claimable: [],
              hint: `a human lifts it: musterd resume ${targetMember.name}`,
            });
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'claim.refused',
              target: targetMember.name,
              result: 'deny',
              detail: { code: 'halted', halted_by: targetMember.halted_by },
            });
            return;
          }
          if (targetMember) {
            const status = resolveAccountStatus(targetMember);
            if (status === 'disabled' || status === 'banned') {
              const claimable = await claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: status,
                message: `seat "${targetMember.name}" is ${status}`,
                claimable,
                hint: `contact a team admin to re-enable this seat`,
              });
              await appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: targetMember.name,
                result: 'deny',
                detail: { code: status },
              });
              return;
            }
          }

          // ADR 444: a wake never displaces an attended session. Refused before any authorization
          // step so the claim has no side effects — no grant consumed, no request opened.
          // ADR 494 §4: provenance settled against the frame's lease token — `dream` only with a
          // dream lease of this seat's, and a dream lease cannot be shed.
          // ADR 609: the refusal protects only what attached at or before the lease mint. A row
          // that attached AFTER — into the spawn window between the daemon's idle observation and
          // this claim — is displaced at OCCUPY instead (`leaseWindowSneaks`); and a claim settling
          // to wake/dream without presenting this seat's own lease opens no window at all.
          const frameProvenance =
            targetMember && targetMember.kind === 'agent'
              ? ((await settleProvenance(
                  ctx.db,
                  targetMember,
                  frame.provenance,
                  frame.wake_lease,
                )) ?? null)
              : null;
          const leaseWindowSneaks = new Set<string>();
          if (
            targetMember &&
            targetMember.kind === 'agent' &&
            targetMember.observer === 0 &&
            (frameProvenance === 'wake' || frameProvenance === 'dream')
          ) {
            const attended = await attendedSessionRows(
              ctx.db,
              ctx.hub.connsForMember(targetMember.id).map((c) => c.presenceId),
            );
            if (attended.length > 0) {
              const minted = frame.wake_lease
                ? await ownLeaseCreatedAt(ctx.db, targetMember.id, frame.wake_lease)
                : null;
              const protectedRows =
                minted === null ? attended : attended.filter((r) => r.created_at <= minted);
              if (protectedRows.length > 0) {
                send(ws, {
                  type: 'refused',
                  code: 'claim_conflict',
                  message: `seat "${targetMember.name}" is held by an attended session — a wake does not displace it`,
                  claimable: await claimableSeats(ctx, team.id),
                  hint: 'the act stays due; the wake is retried once the seat is idle',
                });
                await appendAudit(ctx.db, team.id, {
                  actor: null,
                  action: 'claim.refused',
                  target: targetMember.name,
                  result: 'deny',
                  detail: {
                    code: 'claim_conflict',
                    reason: minted === null ? 'attended_session' : 'attended_predates_lease',
                  },
                });
                return;
              }
              for (const r of attended) leaseWindowSneaks.add(r.presenceId);
            }
          }

          const sameWorkspacePredecessors: string[] = [];
          let displacedModel: string | null = null;
          // Step 4: authorize. Refused and pending claims must not mutate the incumbent.
          let reseated = false;
          if (frame.grant) {
            const gv = await validateGrant(ctx.db, team.id, frame.grant);
            if (!gv.ok) {
              const code = gv.reason === 'expired' ? 'expired_grant' : 'forbidden';
              const claimable = await claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code,
                message: `grant ${gv.reason}`,
                claimable,
                hint: 'request a new grant from a team admin',
              });
              await appendAudit(ctx.db, team.id, {
                actor: null,
                action: 'claim.refused',
                target: targetMember?.name ?? null,
                result: 'deny',
                detail: { code, reason: gv.reason },
              });
              return;
            }
            // Validate grant target matches claim target.
            const grantTarget = gv.grant.target;
            const targetOk =
              ('seat' in frame.target &&
                gv.grant.scope === 'seat' &&
                grantTarget === frame.target.seat) ||
              ('role' in frame.target &&
                gv.grant.scope === 'role' &&
                grantTarget === frame.target.role);
            if (!targetOk) {
              const claimable = await claimableSeats(ctx, team.id);
              send(ws, {
                type: 'refused',
                code: 'forbidden',
                message: `grant is for ${gv.grant.scope} "${grantTarget}", not "${encodeTarget(frame.target)}"`,
                claimable,
                hint: 'request a grant that matches your target seat/role',
              });
              return;
            }
            await consumeGrant(ctx.db, gv.grant.id);
            // Resume token (ADR 087): a reusable grant survives consumeGrant — refresh its TTL so an
            // actively-reconnecting seat never expires. No-op for single_use/standing grants.
            await refreshGrant(ctx.db, gv.grant.id, ctx.config.resumeTtlMs);
            // OCCUPY — fall through to the common occupy block below.
          } else if (authenticatedAs && targetMember && authenticatedAs.id === targetMember.id) {
            // Credential self-authorize (ADR 077): a human authenticated by their own mscr_ credential
            // claiming their own seat is self-authorizing — no grant, no admin-approval request. Fall
            // through to OCCUPY (symmetric with the POST /claim credential-occupy path).
          } else if (
            authenticatedAs === null &&
            targetMember &&
            targetMember.kind === 'agent' &&
            'seat' in frame.target &&
            isHeld(targetMember) &&
            (await getPolicy(ctx.db, team.id)).standing_reseat_known_agents
          ) {
            // Dogfood-mode re-seat (ADR 146, on ADR 145 §7). The seat-claim wall is a gate meant for
            // *strangers* firing on *teammates*: 27 claim requests in the record, 7 expired unanswered
            // at the 1h TTL, 7 approvals of the *same* seat in four days — which taught the workaround
            // of self-approving `--as nick`. So when the team opts in, an agent harness (team agent key,
            // `authenticatedAs === null`) re-claiming an **already-bound named agent seat** occupies now,
            // as a notification — never a decision. Guards keep admission gated: a human credential can't
            // reach here (it self-authorizes above or is refused), a **never-bound** seat (`!isHeld`)
            // stays a real request (new-member admission), a role-pool claim stays gated (assignment,
            // not reclaim), and the shared agent key can't auto-occupy a *human* seat (`kind === 'agent'`
            // only). The authorization is derived from `policy + bound_at`, not a stored grant row.
            reseated = true;
            // Fall through to OCCUPY.
          } else {
            // Step 6: no grant → open a claim request and hold the WS open.
            const encodedTarget = 'observe' in frame.target ? null : encodeTarget(frame.target);
            const req = await createRequest(ctx.db, team.id, {
              kind: 'claim',
              from_session: state.connId,
              target: encodedTarget,
              surface: frame.surface,
              // Carry the attestation across the approval gap (ADR 101) so the approved occupancy
              // isn't born `unknown`.
              model: frame.model ?? null,
              // Tier rides with the id: no model, no source (the pair is meaningless split).
              model_source: frame.model ? (frame.model_source ?? null) : null,
              // A specific-seat claim collapses to one pending request per seat, refreshing the waiter
              // to this newest session — a reconnecting grant-less agent can't stack duplicates.
              collapseByTarget: 'seat' in frame.target,
            });
            // Add a provisional pending connection (not in byMember — no deliver routing).
            const pendingConn: Connection = {
              connId: state.connId,
              memberId: targetMember?.id ?? '',
              memberName: targetMember?.name ?? '',
              teamId: team.id,
              presenceId: '',
              awaitingClaim: req.id,
              isAdmin: false,
              workspace: frame.workspace ?? null,
              workspaceKey: frame.workspace_key ?? null,
              isOpen: () => ws.readyState === ws.OPEN,
              send: (f) => send(ws, f),
              close: () => ws.close(),
              _claimApproved: async (presenceId, sameWorkspacePredecessors = []) => {
                state.authenticated = true;
                state.conn = {
                  connId: state.connId,
                  memberId: targetMember?.id ?? '',
                  memberName: targetMember?.name ?? '',
                  teamId: team.id,
                  presenceId,
                  observer: targetMember?.observer === 1,
                  // Firehose visibility (ADR 136 / ADR 407) — same grade the history read uses, so the
                  // live stream and `GET /messages` can never disagree about what this seat may see.
                  visibility: targetMember ? messageVisibilityOf(targetMember) : 'public',
                  workspace: frame.workspace ?? null,
                  workspaceKey: frame.workspace_key ?? null,
                  surface: frame.surface,
                  send: (f) => send(ws, f),
                  close: () => ws.close(),
                };
                // Promote from pending to full member slot in hub.
                ctx.hub.remove(state.connId);
                ctx.hub.add(state.conn);
                const evictionTimer = await scheduleSameWorkspaceEviction(
                  ctx,
                  team.id,
                  state.connId,
                  targetMember?.name ?? '',
                  sameWorkspacePredecessors,
                );
                if (evictionTimer) state.evictionTimer = evictionTimer;
              },
            };
            ctx.hub.addPending(pendingConn);
            send(ws, {
              type: 'pending',
              request_id: req.id,
              message: `claim request ${req.id} opened — waiting for admin approval`,
            });
            // Notify admins.
            ctx.hub.deliverToAdmins(team.id, {
              type: 'pending',
              request_id: req.id,
              message: `seat claim request from ${frame.surface}: ${encodedTarget ?? 'teammate'}`,
            });
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'claim.pending',
              target: targetMember?.name ?? null,
              result: 'allow',
              detail: { request_id: req.id, surface: frame.surface },
            });
            log.info({
              msg: 'ws_claim_pending',
              team: team.slug,
              target: encodedTarget,
              request: req.id,
              conn: state.connId,
            });
            return; // WS stays open — admin decision arrives via hub.deliverClaimDecision
          }

          // Step 5: transition an AUTHORIZED claim. Single-active is **kind-scoped** (ADR 042): an
          // agent seat is newest-wins (ADR 017), while a human/observer seat fans out. Displacement is
          // workspace-scoped (ADR 068): same-workspace predecessors survive until the authorized
          // successor proves durable (ADR 092); a claim with no workspace displaces all incumbents.
          if (
            targetMember &&
            !('observe' in frame.target) &&
            targetMember.kind === 'agent' &&
            targetMember.observer === 0
          ) {
            // Identity first, label only as a fallback (lane 01M1JQYYAC): `frame.workspace` is a
            // display label qualified with the git branch, so it changes under the very session it
            // identifies — a branch switch or a detached HEAD renamed it, this comparison read the
            // seat's own re-attach as a foreign workspace, and the grace below never engaged. When
            // both sides carry a `workspace_key` (the work tree root) that is the whole test; when
            // either does not (an older dist), fall back to exactly the previous behaviour.
            const sameWorkspace = (old: Connection): boolean => {
              if (frame.workspace_key != null && old.workspaceKey != null) {
                return old.workspaceKey === frame.workspace_key;
              }
              return (
                old.workspace != null &&
                frame.workspace != null &&
                old.workspace === frame.workspace
              );
            };
            displacedModel =
              (
                await ctx.db.get<{ model: string }>(
                  'SELECT model FROM presence WHERE member_id = ? AND model IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1',
                  [targetMember.id],
                )
              )?.model ?? null;
            const orphaned = (
              await ctx.db.get<{ count: number }>(
                'SELECT count(*) AS count FROM presence WHERE member_id = ? AND conn_id IS NULL',
                [targetMember.id],
              )
            )?.count;
            let displaced = 0;
            const displacedSessions: DisplacedSession[] = [];
            const successor = { provenance: frameProvenance, surface: frame.surface };
            for (const old of ctx.hub.connsForMember(targetMember.id)) {
              if (sameWorkspace(old) && !leaseWindowSneaks.has(old.presenceId)) {
                // ADR 489: only a same-surface successor is a reload of `old`. A CLI wait or watch
                // in an adapter's workspace is a second reader — neither reaped nor displaced.
                if (isReloadOf(old, frame.surface)) sameWorkspacePredecessors.push(old.connId);
                continue;
              }
              // Lane 01M3TB3EY9: read what is being displaced BEFORE the row is cleared.
              const was = await describeDisplaced(ctx.db, old.presenceId);
              if (was) displacedSessions.push(was);
              old.send?.({
                type: 'error',
                code: 'superseded',
                message: supersededMessage(targetMember.name, successor),
              });
              old.close?.();
              ctx.hub.remove(old.connId);
              await clearPresenceById(ctx.db, old.presenceId);
              displaced++;
            }
            const evicted = displaced + (orphaned ?? 0);
            if (evicted > 0) {
              await appendAudit(ctx.db, team.id, {
                actor: targetMember.name,
                action: 'claim.superseded',
                target: targetMember.name,
                result: 'allow',
                detail: {
                  same_workspace: false,
                  evicted,
                  via: 'ws',
                  successor_provenance: successor.provenance,
                  successor_surface: successor.surface,
                  displaced: displacedSessions,
                },
              });
            }
            await clearOrphanPresence(ctx.db, targetMember.id);
          }

          // OCCUPY: attach presence and complete the handshake.
          if (!targetMember) {
            // Anonymous observe-target ({ observe: true }) isn't built yet; a *named* observer seat is
            // claimable via `target: { seat: <name> }`. Refuse gracefully and point at that.
            send(ws, {
              type: 'refused',
              code: 'forbidden',
              message: 'anonymous observe-target via claim not yet supported',
              claimable: [],
              hint: 'claim a named observer seat: target { seat: "<name>" }',
            });
            return;
          }
          const presence = await attach(ctx.db, targetMember.id, frame.surface, state.connId, {
            // ADR 121/131 §6: provenance is stamped on AGENT seats only — the same gate
            // `ambientTouch` applies in http.ts and the stateless claim mirror applies since #1309.
            // This was the last claim path without it: a human frame could declare itself `wake`,
            // which is the word the wake actuators read to conclude a seat is their own spawned
            // child (`verified.provenance !== 'wake'` in backends/claudeCode.ts, codex.ts, grok.ts,
            // opencode.ts). A person's shell must not be able to say it.
            provenance: frameProvenance,
            workspace: frame.workspace ?? null,
            driver: frame.driver ?? null,
            model: frame.model ?? null,
            model_source: frame.model ? (frame.model_source ?? null) : null,
            build: frame.build ?? null,
            epoch: frame.epoch ?? null,
            // ADR 417: what this seat's WORKSPACE is running, read from its own files — not the
            // ceiling `epoch` says this build could write. The two disagree exactly when a seat is
            // stale, which is the whole point of carrying both.
            guidance_epoch: frame.guidance_epoch ?? null,
            style_epoch: frame.style_epoch ?? null,
            wake_lease: frame.wake_lease ?? null,
          });
          // First occupancy stamps the durable *held* marker (ADR 058) — the claim path is the v0.3
          // successor to the v0.2 first-token-touch that used to do this; keeps the ADR 070 derivation.
          await markBound(ctx.db, targetMember.id);
          let agentAuthority: { seat_credential?: string; session_lease?: string } = {};
          if (targetMember.kind === 'agent' && targetMember.observer === 0) {
            const credential =
              targetMember.credential_hash === null
                ? (await mintAgentSeatCredential(ctx.db, targetMember.id)).seat_credential
                : undefined;
            const lease = await mintSessionLease(ctx.db, {
              teamId: team.id,
              memberId: targetMember.id,
              presenceId: presence.id,
            });
            state.lease = { id: lease.id };
            if (credential) {
              await appendAudit(ctx.db, team.id, {
                actor: targetMember.name,
                action: 'agent_seat_credential.minted',
                target: targetMember.name,
                result: 'allow',
                detail: { source: 'claim' },
              });
            }
            await appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'agent_session_lease.minted',
              target: targetMember.name,
              result: 'allow',
              detail: { lease_id: lease.id, presence_id: presence.id },
            });
            agentAuthority = {
              ...(credential ? { seat_credential: credential } : {}),
              session_lease: lease.session_lease,
            };
          }
          const conn: Connection = {
            connId: state.connId,
            memberId: targetMember.id,
            memberName: targetMember.name,
            teamId: team.id,
            presenceId: presence.id,
            observer: targetMember.observer === 1,
            isAdmin: resolveCapabilities(targetMember).is_admin,
            // Firehose visibility (ADR 136 / ADR 407) — same grade the history read uses, so the live
            // stream and `GET /messages` can never disagree about what this seat may see.
            visibility: messageVisibilityOf(targetMember),
            workspace: frame.workspace ?? null,
            workspaceKey: frame.workspace_key ?? null,
            surface: frame.surface,
            send: (f) => send(ws, f),
            close: () => ws.close(),
          };
          state.authenticated = true;
          state.conn = conn;
          ctx.hub.add(conn);
          recordPresenceChurn('attach', frame.surface);
          send(ws, {
            type: 'occupied',
            seat: toMember(targetMember, team.slug),
            presence_id: presence.id,
            server_time: Date.now(),
            charter: (await getRoleCharter(ctx.db, team.id, targetMember.role)) ?? undefined,
            ...agentAuthority,
            memory: await memoryEnvelope(ctx.db, targetMember.id),
            // ADR 514 inc 3: the block this seat reads — a human claimant's own, else the driver
            // this claim declared (recorded, not verified), else the only-human rule.
            style: await styleEnvelopeFor(
              ctx.db,
              team.id,
              await styleDriverFor(ctx.db, team.id, targetMember, frame.driver ?? null),
            ),
          });
          if (!conn.observer) emitPresence(ctx, conn, 'online', frame.surface);
          // ADR 092: now that this successor is occupied, arm the grace-gated reap of any same-workspace
          // predecessor it displaced (the orphaned pre-reload sessions). Cancelled if it closes first.
          const evictionTimer = await scheduleSameWorkspaceEviction(
            ctx,
            team.id,
            state.connId,
            targetMember.name,
            sameWorkspacePredecessors,
          );
          if (evictionTimer) state.evictionTimer = evictionTimer;
          if (reseated) {
            // Dogfood-mode re-seat (ADR 146): the durable notification-not-a-decision record. The
            // presence-online emit above already tells the team (admins included) the seat is live; the
            // loud, directed admin surface for asks/approvals is the next item (ask-stream, ADR 145 §3).
            await appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'claim.reseated',
              target: targetMember.name,
              result: 'allow',
              detail: { surface: frame.surface, policy: 'standing_reseat_known_agents' },
            });
          } else {
            await appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'claim.occupied',
              target: targetMember.name,
              result: 'allow',
              detail: { surface: frame.surface },
            });
          }
          // ADR 101: the initial attestation is the first entry in the occupancy's model history —
          // the audit log IS the switch history (old → new, source), never a table.
          // ADR 101 + ADR 246: the occupancy's opening entry, whichever it is. A claim that attests
          // NOTHING is not a non-event — if this seat's previous occupancy attested a model, the
          // seat has just left the ADR 188 pool, and before ADR 246 the ledger could not say so
          // even in hindsight, because an occupancy born null has no old→new transition to audit.
          if (!frame.model && displacedModel && sameWorkspacePredecessors.length === 0) {
            await appendAudit(ctx.db, team.id, {
              actor: targetMember.name,
              action: 'occupancy.model_attested',
              target: targetMember.name,
              result: 'allow',
              detail: { occupancy: presence.id, old: displacedModel, new: null, source: 'claim' },
            });
          } else {
            await recordClaimAttestation(ctx.db, team.id, targetMember, presence.id, frame.model);
          }
          log.info({
            msg: 'ws_claim_occupied',
            team: team.slug,
            member: targetMember.name,
            conn: state.connId,
          });
          return;
        }

        if (!state.authenticated || !state.conn) {
          throw new MusterdError('unauthorized', 'send a claim frame first');
        }
        const conn = state.conn;

        switch (frame.type) {
          case 'subscribe': {
            // `team-all` = the firehose: this connection receives every envelope routed on the team,
            // not just recipient-matched ones — for read-only observers like the dashboard (ADR 061).
            // Gated on `can_observe` (ADR 071, P2): a seat narrowed to `can_observe:false` is refused the
            // firehose. Generalist `can_observe:true` keeps every observer/dashboard working.
            if (frame.scope === 'team-all') {
              const subscriber = await getMemberById(ctx.db, conn.memberId);
              if (subscriber && !resolveCapabilities(subscriber).can_observe) {
                await appendAudit(ctx.db, conn.teamId, {
                  actor: conn.memberName,
                  action: 'observe.denied',
                  target: null,
                  result: 'deny',
                });
                throw new MusterdError(
                  'forbidden',
                  `seat "${conn.memberName}" lacks the can_observe capability`,
                );
              }
              ctx.hub.subscribeFirehose(conn.connId);
            }
            send(ws, { type: 'subscribed', scope: frame.scope });
            break;
          }
          case 'heartbeat': {
            if (await presenceById(ctx.db, conn.presenceId)) {
              await heartbeat(ctx.db, conn.presenceId, frame.status);
              // ADR 347: renew the agent session lease over the live socket before it expires. The
              // adapter's HTTP tools present `config.sessionLease`, which was minted once at claim
              // and lived five minutes — after which every tool call was refused until a reconnect
              // happened to mint another (lane 01M1FC77F2, 2026-09-01). The old lease is not
              // revoked: it dies at its own expiry, so a call in flight under it still lands.
              // ADR 501: a halted seat renews nothing — the halt revoked its leases on purpose, and
              // a heartbeat racing the eviction must not mint a fresh one behind it.
              const haltedNow = (await getMemberById(ctx.db, conn.memberId))?.halted_at;
              if (
                state.lease &&
                (haltedNow === null || haltedNow === undefined) &&
                (await sessionLeaseDueForRenewal(
                  ctx.db,
                  state.lease.id,
                  AGENT_SESSION_LEASE_RENEW_AHEAD_MS,
                ))
              ) {
                const renewed = await mintSessionLease(ctx.db, {
                  teamId: conn.teamId,
                  memberId: conn.memberId,
                  presenceId: conn.presenceId,
                });
                await appendAudit(ctx.db, conn.teamId, {
                  actor: conn.memberName,
                  action: 'agent_session_lease.renewed',
                  target: conn.memberName,
                  result: 'allow',
                  detail: { previous: state.lease.id, lease: renewed.id, source: 'heartbeat' },
                });
                state.lease = { id: renewed.id };
                send(ws, {
                  type: 'lease',
                  session_lease: renewed.session_lease,
                  expires_at: renewed.expires_at,
                });
              }
              // ADR 101 re-attestation: a mid-occupancy model switch rides the heartbeat. Only a
              // real change writes + audits (occupancy.model_attested, old → new).
              if (frame.model) {
                const changed = await reattestModel(
                  ctx.db,
                  conn.presenceId,
                  frame.model,
                  // The pair, not the id alone: without the tier the store cannot tell a
                  // re-affirmation from a tier-erasing write (see reattestModel).
                  frame.model_source,
                );
                if (changed) {
                  await appendAudit(ctx.db, conn.teamId, {
                    actor: conn.memberName,
                    action: 'occupancy.model_attested',
                    target: conn.memberName,
                    result: 'allow',
                    detail: {
                      occupancy: conn.presenceId,
                      old: changed.previous,
                      new: frame.model,
                      source: 'heartbeat',
                    },
                  });
                }
              }
              // ADR 275: occupancy follows capture. Absent ⇒ no change (never a clear). No
              // audit row — presence.surface is the instrument.
              if (frame.surface) {
                await reattestSurface(ctx.db, conn.presenceId, frame.surface);
              }
              // ADR 417: the guidance a seat RUNS can change under a live session — self-heal fires
              // once, at session start, so a long session outlives the rule it started under and a
              // refresh rewrites its files while the socket stays open. Absent ⇒ no change. No audit
              // row by design (ADR 417 §Observability): this is occupancy state, not an event.
              await reattestGuidanceEpoch(ctx.db, conn.presenceId, frame.guidance_epoch);
              // ADR 514: the style block a seat runs changes when an admin or the human moves a
              // dial; the adapter re-sends the epoch it read, and the roster follows.
              await reattestStyleEpoch(ctx.db, conn.presenceId, frame.style_epoch);
              // ADR 558: whether an idle session can be pushed a turn. An audit row on change only —
              // the roster column is increment 5; until then this row is the instrument.
              if (frame.hearing && frame.hearing !== state.hearing) {
                state.hearing = frame.hearing;
                await appendAudit(ctx.db, conn.teamId, {
                  actor: conn.memberName,
                  action: 'presence.hearing',
                  target: conn.memberName,
                  result: 'allow',
                  detail: {
                    occupancy: conn.presenceId,
                    hearing: frame.hearing,
                    reason: frame.hearing_reason ?? null,
                  },
                });
              }
            } else {
              // The row behind this socket is gone — the reaper removed it while the socket stayed
              // open — and the session lease that joined on it is dead with it, so every hook probe
              // this seat runs is refused. Dropping the heartbeat on the floor left the socket a
              // zombie: subscribed, receiving broadcasts, deaf, and never told. Measured 2026-09-14
              // (lane 01M2GBPX2S): ghost's socket was reaped at 15:58:37Z and stayed open and deaf
              // for 19 minutes, 33 refusals, until it happened to drop. Close it: the adapter's
              // reconnect re-claims, the `occupied` frame mints a new Presence and lease, and #1369
              // writes that lease where the hook reads it. The row is the tell that separates
              // "refused because reaped" from "refused because dead".
              log.warn({
                msg: 'ws_heartbeat_reaped',
                member: conn.memberName,
                conn: conn.connId,
                presence: conn.presenceId,
              });
              ws.close(4410, 'presence reaped — re-claim');
            }
            break;
          }
          case 'send': {
            const env = parseEnvelope(frame.envelope);
            const team = await ctx.db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [
              conn.teamId,
            ]);
            const member = await ctx.db.get<import('../store/rows.js').MemberRow>(
              'SELECT * FROM members WHERE id = ?',
              [conn.memberId],
            );
            if (!team || !member)
              throw new MusterdError('server_error', 'connection lost its identity');
            const teamRow = (await ctx.db.get<import('../store/rows.js').TeamRow>(
              'SELECT * FROM teams WHERE id = ?',
              [conn.teamId],
            ))!;
            // Pass this connection's occupancy id so the per-act model stamp reads *this* session's
            // attestation, not the member's newest presence (ADR 101).
            const result = await routeEnvelope(
              ctx,
              teamRow,
              member,
              env,
              conn.presenceId,
              false,
              conn.connId,
            );
            send(ws, { type: 'ack', id: result.message.id });
            break;
          }
        }
      } catch (err) {
        const me = asMusterdError(err);
        recordError(me.code);
        send(ws, me.toFrame());
        // A claim that dies inside the handler is TERMINAL for this socket, and saying so is the
        // whole fix (found 2026-08-12, ADR 251 live wake). The error frame above already carried the
        // real cause; what was missing is that the connection stayed open in an unauthenticated
        // half-state, so a client that made nothing of the frame had no second signal and waited out
        // its own timeout instead. Closing is that second signal — and the audit row is the first
        // trace a failed claim has ever left, which is why the original diagnosis had to be done
        // from an agent's transcript rather than from the ledger.
        if (frame.type === 'claim' && !state.authenticated) {
          try {
            const team = await requireTeam(ctx.db, frame.team);
            await appendAudit(ctx.db, team.id, {
              actor: null,
              action: 'claim.failed',
              target: encodeTarget(frame.target),
              result: 'deny',
              detail: { code: me.code, error: me.message, surface: frame.surface },
            });
          } catch {
            // Best-effort: an unresolvable team is itself a plausible cause of the throw, and a
            // failed audit write must never mask the failure it was trying to record.
          }
          log.warn({
            msg: 'ws_claim_failed',
            team: frame.team,
            target: encodeTarget(frame.target),
            surface: frame.surface,
            code: me.code,
            error: me.message,
            conn: state.connId,
          });
          ws.close();
        }
      }
    };
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', async (data) => {
      chain = chain
        .then(() => handleMessage(data))
        .catch((err) => log.warn({ msg: 'ws_frame_failed', err: String(err) }));
    });

    const cleanup = async () => {
      // Cancel any pending same-workspace reap this connection armed (ADR 092): a successor that drops
      // within the grace must not evict on behalf of a now-dead session (the getConn gate also guards
      // this, but clearing the timer is tidier and stops the audit row).
      if (state.evictionTimer) {
        clearTimeout(state.evictionTimer);
        delete state.evictionTimer;
      }
      const conn = state.conn;
      if (!conn) {
        // A waiting claimant has no Presence yet, but it is still registered by connId so an admin can
        // answer it. Once its socket closes, it is not a valid approval target and must not later be
        // promoted into a phantom connection by the HTTP decision path.
        ctx.hub.remove(state.connId);
        return;
      }
      ctx.hub.remove(conn.connId);
      recordPresenceChurn('detach');
      // Keep the row as a reclaim hold for the grace window instead of deleting it (ADR 010).
      await release(ctx.db, conn.presenceId, ctx.config.reclaimGraceMs);
      // Emit offline only if the member now has no live presence anywhere — never for an observer.
      if (
        !conn.observer &&
        !(await hasLivePresence(ctx.db, conn.memberId, ctx.config.presenceTimeoutMs))
      ) {
        emitPresence(ctx, conn, 'offline');
      }
      log.info({
        msg: 'ws_close',
        member: conn.memberName,
        conn: conn.connId,
        code: state.closeCode ?? null,
        reason: state.closeReason || null,
        error: state.closeError ?? null,
        lived_ms: Date.now() - state.openedAt,
      });
    };

    // Behind the frame chain: a frame still in flight must settle before the row is released.
    // Caught: on Postgres `release` rejects when the pool cannot hand out a connection, and an
    // unhandled rejection here exited the server mid-load test, dropping every team on the machine
    // (2026-10-02, lane 01M3ZC3EXN). A row left behind ages out: the reaper takes it offline.
    const closeAfterFrames = () => {
      chain = chain
        .then(cleanup, cleanup)
        .catch((err: unknown) =>
          log.warn({ msg: 'ws_cleanup_failed', conn: state.connId, err: String(err) }),
        );
    };
    ws.on('close', (code, reason) => {
      state.closeCode = code;
      state.closeReason = reason.toString('utf8').slice(0, 120);
      closeAfterFrames();
    });
    ws.on('error', (err) => {
      state.closeError = String(err instanceof Error ? err.message : err).slice(0, 200);
      closeAfterFrames();
    });
  });

  return wss;
}
