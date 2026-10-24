import {
  AuthorityRelayRequestSchema,
  AuthorityRelayResponseSchema,
  ERROR_HTTP_STATUS,
  ErrorBodySchema,
  type AuthorityRelayRequest,
  type AuthorityRelayResponse,
} from '@musterd/protocol';
import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { routeEnvelope } from '../protocol/route.js';
import { appendAudit } from '../store/audit.js';
import {
  buildDescriptor,
  enrollKeyGuarded,
  enrollPasskeyGuarded,
  getDescriptorByNonce,
  getParkedProof,
  getPasskeysForDescriptor,
  issueEnrollmentChallenge,
  listDeviceKeys,
  revokeKeyGuarded,
  storePasskeyProof,
  requireAuthority,
} from '../store/authority.js';
import { getLane } from '../store/lanes.js';
import { getMemberById, getMemberByName, leaveMember, setMemberCeiling } from '../store/members.js';
import { rowToEnvelope } from '../store/messages.js';
import { clearMemberPresence } from '../store/presence.js';
import { resolveCapabilities } from '../store/rows.js';
import type { TeamRow } from '../store/rows.js';
import { revokeSponsoredDescendants } from '../store/sponsoredCascade.js';
import { archiveTeam } from '../store/teams.js';
import { assertSeatAlreadyResident, arbitrateLanePatch } from './claim.js';
import { diagnoseHubFailure, failureCode } from './hubDiagnosis.js';

type RelayNode = { id: string; label: string };

function relayError(
  code: 'forbidden' | 'not_found' | 'validation' | 'hub_local_required',
  message: string,
): never {
  throw new MusterdError(code, message);
}

/** Hub-side handler for the closed authority operation protocol (ADR 728/729). */
export async function handleAuthorityRelay(
  ctx: Ctx,
  team: TeamRow,
  node: RelayNode,
  raw: unknown,
): Promise<AuthorityRelayResponse> {
  const request = AuthorityRelayRequestSchema.parse(raw);
  const member = 'actor' in request ? await getMemberByName(ctx.db, team.id, request.actor) : null;
  if ('actor' in request) {
    if (!member || member.left_at !== null || member.kind !== 'human' || member.observer !== 0) {
      relayError('forbidden', 'authority relay requires a current human member');
    }
    await assertSeatAlreadyResident(ctx.db, team.id, member, node, `authority relay ${request.op}`);
  }

  const webauthnOrigins = [...new Set(ctx.config.webauthnOrigins)];
  const mappedOrigin = ctx.config.webauthnNodeOrigins[node.id];
  const relayOrigins = mappedOrigin ? [mappedOrigin.origin] : [];
  const assertAdmin = () => {
    if (!member || !resolveCapabilities(member).is_admin) {
      relayError('forbidden', 'this authority relay operation requires an admin human');
    }
  };
  const requireRelayAuthority = async (
    act: 'admin.roster' | 'admin.team_settings' | 'human_accept' | 'set_authorized_by',
    target: string,
    payload: unknown,
    approval: import('@musterd/protocol').ApprovalProof | undefined,
    presenter = member!,
  ) => {
    const result = await requireAuthority(ctx.db, {
      teamId: team.id,
      audience: team.slug,
      presenter,
      credential: presenter.kind === 'human' ? 'human' : 'agent',
      act,
      target,
      payload,
      proof: approval,
      expectedOrigins: relayOrigins,
      expectedNodeId: node.id,
    });
    if (!result.ok) relayError('forbidden', `authority refused (${result.reason}) for ${act}`);
  };
  let response: AuthorityRelayResponse;
  switch (request.op) {
    case 'keys.list': {
      const keys = await listDeviceKeys(ctx.db, team.id, member!.id);
      response = {
        op: request.op,
        keys: keys.map((key) => ({
          id: key.id,
          kind: key.kind,
          created_at: key.createdAt,
          revoked_at: key.revokedAt,
        })),
      };
      break;
    }
    case 'enrollment.challenge.create': {
      if (!mappedOrigin) relayError('validation', 'this node has no configured WebAuthn origin');
      const issued = await issueEnrollmentChallenge(ctx.db, {
        teamId: team.id,
        memberId: member!.id,
        actor: member!.name,
        nodeId: node.id,
        ceremonyOrigin: mappedOrigin.origin,
        ceremonyRpId: mappedOrigin.rp_id,
      });
      response = { op: request.op, challenge: issued.challenge, expires_at: issued.expiresAt };
      break;
    }
    case 'keys.enroll': {
      if (request.kind === 'phone')
        relayError('validation', 'a phone key is enrolled by pairing the musterd app');
      const result = await enrollKeyGuarded(ctx.db, {
        teamId: team.id,
        audience: team.slug,
        member: member!,
        publicKey: request.public_key,
        kind: request.kind,
        proof: request.approval,
        expectedOrigins: relayOrigins,
        expectedNodeId: node.id,
      });
      if (!result.ok)
        relayError(
          result.reason === 'agent_credential' ? 'forbidden' : 'validation',
          `key enrollment refused (${result.reason})`,
        );
      response = { op: request.op, key: { id: result.key.id, kind: result.key.kind } };
      break;
    }
    case 'passkeys.enroll': {
      if (!mappedOrigin) relayError('validation', 'this node has no configured WebAuthn origin');
      const confirmer = request.countersign
        ? await getMemberByName(ctx.db, team.id, request.countersign.confirmer)
        : null;
      const result = await enrollPasskeyGuarded(ctx.db, {
        teamId: team.id,
        audience: team.slug,
        member: member!,
        challenge: request.challenge,
        proof: request.approval,
        countersign:
          request.countersign && confirmer
            ? {
                confirmer,
                isAdmin:
                  confirmer.kind === 'human' &&
                  confirmer.left_at === null &&
                  resolveCapabilities(confirmer).is_admin,
                proof: request.countersign.approval,
              }
            : undefined,
        registration: {
          attestationObject: Buffer.from(request.registration.attestation_object, 'base64url'),
          clientDataJson: request.registration.client_data_json,
        },
        expectedOrigins: [mappedOrigin.origin],
        expectedRpId: mappedOrigin.rp_id,
        expectedNodeId: node.id,
        ceremonyOrigin: mappedOrigin.origin,
        countersignExpectedOrigins: webauthnOrigins,
      });
      if (!result.ok)
        relayError(
          result.reason === 'agent_credential' ? 'forbidden' : 'validation',
          `passkey enrollment refused (${result.reason})`,
        );
      response = { op: request.op, key: { id: result.key.id, kind: result.key.kind } };
      break;
    }
    case 'keys.revoke': {
      const result = await revokeKeyGuarded(ctx.db, {
        teamId: team.id,
        audience: team.slug,
        member: member!,
        keyId: request.key_id,
        proof: request.approval,
        expectedOrigins: relayOrigins,
        expectedNodeId: node.id,
      });
      if (!result.ok)
        relayError(
          result.reason === 'not_found' ? 'not_found' : 'validation',
          `key revocation refused (${result.reason})`,
        );
      response = { op: request.op, ok: true };
      break;
    }
    case 'descriptor.create': {
      response = {
        op: request.op,
        descriptor: await buildDescriptor(ctx.db, {
          teamId: team.id,
          audience: team.slug,
          memberId: member!.id,
          actor: member!.name,
          act: request.act,
          target: request.target,
          payload: JSON.parse(request.payload_json) as unknown,
          nodeId: node.id,
        }),
      };
      break;
    }
    case 'descriptor.read': {
      const descriptor = await getDescriptorByNonce(
        ctx.db,
        team.id,
        team.slug,
        request.nonce,
        Date.now(),
        node.id,
      );
      if (!descriptor) relayError('not_found', 'no live descriptor for that nonce on this node');
      response = {
        op: request.op,
        descriptor,
        passkeys: await getPasskeysForDescriptor(ctx.db, team.id, request.nonce),
      };
      break;
    }
    case 'proof.present': {
      if (!mappedOrigin) relayError('validation', 'this node has no configured WebAuthn origin');
      const parked = await storePasskeyProof(ctx.db, {
        teamId: team.id,
        audience: team.slug,
        proof: request.proof,
        expectedOrigins: relayOrigins,
        expectedNodeId: node.id,
      });
      if (!parked) relayError('validation', 'that approval does not verify for its descriptor');
      response = { op: request.op, ok: true };
      break;
    }
    case 'proof.read': {
      const descriptor = await getDescriptorByNonce(
        ctx.db,
        team.id,
        team.slug,
        request.nonce,
        Date.now(),
        node.id,
      );
      if (!descriptor) relayError('not_found', 'no live descriptor for that nonce on this node');
      if (descriptor.actor !== request.actor)
        relayError('forbidden', 'that descriptor belongs to another human');
      const keyProof = await getParkedProof(ctx.db, team.id, request.nonce);
      if (!keyProof) relayError('not_found', 'no approval parked for that nonce yet');
      response = { op: request.op, proof: keyProof };
      break;
    }
    case 'lane.verdict': {
      const before = await getLane(ctx.db, team.id, request.lane, team.slug);
      if (!before) relayError('not_found', `no lane "${request.lane}"`);
      const result = await arbitrateLanePatch(ctx, team, node, {
        lane: request.lane,
        seat: member!.name,
        patch: {
          state: request.verdict === 'accept' ? 'done' : 'active',
          ...(request.approval ? { approval: request.approval } : {}),
        },
        expect: { owner_seat: before.owner_seat, state: before.state },
      });
      if (request.verdict === 'decline') {
        await appendAudit(ctx.db, team.id, {
          actor: member!.name,
          action: 'lane.review_sent_back',
          target: result.lane.id,
          result: 'allow',
          detail: { lane: result.lane.id, reviewer: member!.name, owner: before.owner_seat },
        });
      }
      response = { op: request.op, lane: result.lane.id, verdict: request.verdict };
      break;
    }
    case 'lane.answer': {
      const ask = await ctx.db.get<{
        id: string;
        from_member: string;
        to_member: string | null;
        to_kind: 'member' | 'team' | 'broadcast';
        thread_id: string | null;
        meta: string | null;
      }>(
        `SELECT id, from_member, to_member, to_kind, thread_id, meta
           FROM messages WHERE team_id = ? AND id = ? AND act = 'ask'`,
        [team.id, request.ask_id],
      );
      if (!ask) relayError('not_found', 'the lane review ask no longer exists');
      if (ask.to_member !== null && ask.to_member !== member!.id) {
        relayError('forbidden', 'that ask is addressed to another member');
      }
      let askMeta: unknown;
      try {
        askMeta = ask.meta ? JSON.parse(ask.meta) : null;
      } catch {
        relayError('validation', 'the lane review ask metadata is invalid');
      }
      if (!askMeta || typeof askMeta !== 'object' || !('lane_review' in askMeta)) {
        relayError('validation', 'that ask is not a lane review');
      }
      const asker = await getMemberById(ctx.db, ask.from_member);
      if (!asker) relayError('not_found', 'the lane review ask sender no longer exists');
      const result = await routeEnvelope(
        ctx,
        team,
        member!,
        makeEnvelope({
          id: ulid(),
          team: team.slug,
          from: member!.name,
          to: { kind: 'member', name: asker.name },
          act: request.act,
          body: request.body,
          thread: ask.thread_id ?? ask.id,
          meta: {
            in_reply_to: ask.id,
            ...(request.approval ? { approval: request.approval } : {}),
            ...(request.claims ? { claims: request.claims } : {}),
          },
        }),
        undefined,
        false,
        undefined,
        node.id,
      );
      response = {
        op: request.op,
        ack: rowToEnvelope(result.message, team.slug, member!.name, asker.name),
        ...(result.lane_verdict ? { lane_verdict: result.lane_verdict } : {}),
        ...(result.lane_authority_refused
          ? { lane_authority_refused: result.lane_authority_refused }
          : {}),
        ...(result.lane_escalation ? { lane_escalation: result.lane_escalation } : {}),
        ...(result.lane_ack ? { lane_ack: result.lane_ack } : {}),
        ...(result.lane_superseded ? { lane_superseded: result.lane_superseded } : {}),
        ...(result.lane_advisory ? { lane_advisory: result.lane_advisory } : {}),
        ...(result.lane_unbound ? { lane_unbound: result.lane_unbound } : {}),
        ...(result.dispute ? { dispute: result.dispute } : {}),
      };
      break;
    }
    case 'lane.authorized_by': {
      const before = await getLane(ctx.db, team.id, request.lane, team.slug);
      if (!before) relayError('not_found', `no lane "${request.lane}"`);
      const authorizer = await getMemberByName(ctx.db, team.id, request.authorized_by);
      if (!authorizer || authorizer.kind !== 'human' || authorizer.left_at !== null) {
        relayError('forbidden', 'authorized_by must name a current human member');
      }
      await assertSeatAlreadyResident(ctx.db, team.id, authorizer, node, 'set authorized_by');
      const merged = {
        ...(before.merged ?? {}),
        ...(request.pr !== undefined ? { pr: request.pr } : {}),
        ...(request.sha !== undefined ? { sha: request.sha } : {}),
        authorized_by: request.authorized_by,
      };
      const result = await arbitrateLanePatch(ctx, team, node, {
        lane: request.lane,
        seat: member!.name,
        patch: { merged, ...(request.approval ? { approval: request.approval } : {}) },
        expect: { owner_seat: before.owner_seat, state: before.state },
      });
      response = {
        op: request.op,
        lane: result.lane.id,
        authorized_by: request.authorized_by,
        pr: result.lane.merged?.pr ?? null,
        sha: result.lane.merged?.sha ?? null,
      };
      break;
    }
    case 'member.remove': {
      assertAdmin();
      await requireRelayAuthority(
        'admin.roster',
        request.target,
        { action: 'remove', name: request.target },
        request.approval,
      );
      const target = await getMemberByName(ctx.db, team.id, request.target);
      if (!target || target.left_at !== null)
        relayError('not_found', `no member "${request.target}"`);
      await leaveMember(ctx.db, target.id);
      const descendants = await revokeSponsoredDescendants(
        ctx.db,
        team.id,
        target,
        'remove',
        member!.name,
      );
      for (const { member: removed } of descendants) {
        for (const conn of ctx.hub.connsForMember(removed.id)) {
          conn.send({
            type: 'error',
            code: 'superseded',
            message: `your session as "${removed.name}" was disabled: sponsor "${target.name}" was removed`,
          });
          conn.close?.();
          ctx.hub.remove(conn.connId);
        }
      }
      for (const conn of ctx.hub.connsForMember(target.id)) {
        conn.send({
          type: 'error',
          code: 'superseded',
          message: `your session as "${target.name}" was removed by an operator`,
        });
        conn.close?.();
        ctx.hub.remove(conn.connId);
      }
      await clearMemberPresence(ctx.db, target.id);
      ctx.hub.broadcastTeam(team.id, { type: 'presence', member: target.name, status: 'offline' });
      await appendAudit(ctx.db, team.id, {
        actor: member!.name,
        action: 'member.remove',
        target: target.name,
        result: 'allow',
      });
      response = {
        op: request.op,
        target: target.name,
        kind: target.kind as 'agent' | 'human',
        removed: true,
      };
      break;
    }
    case 'member.ceiling': {
      assertAdmin();
      await requireRelayAuthority(
        'admin.roster',
        request.target,
        { action: 'ceiling', name: request.target, ceiling: request.ceiling },
        request.approval,
      );
      const target = await getMemberByName(ctx.db, team.id, request.target);
      if (!target || target.left_at !== null)
        relayError('not_found', `no member "${request.target}"`);
      if (target.observer === 1)
        relayError('validation', 'an observer seat has a grade, not a ceiling');
      await setMemberCeiling(ctx.db, target.id, request.ceiling);
      await appendAudit(ctx.db, team.id, {
        actor: member!.name,
        action: 'member.ceiling_set',
        target: target.name,
        result: 'allow',
        detail: { from: target.ceiling ?? null, to: request.ceiling },
      });
      response = { op: request.op, target: target.name, ceiling: request.ceiling };
      break;
    }
    case 'team.archive': {
      assertAdmin();
      await requireRelayAuthority(
        'admin.team_settings',
        team.slug,
        { action: 'archive' },
        request.approval,
      );
      const archived = await archiveTeam(ctx.db, team.slug);
      await appendAudit(ctx.db, team.id, {
        actor: member!.name,
        action: 'team.archive',
        target: team.slug,
        result: 'allow',
      });
      response = { op: request.op, ok: true, archived_at: archived.archived_at };
      break;
    }
  }
  return AuthorityRelayResponseSchema.parse(response);
}

/** Joiner side: forward one closed operation to the hub and accept only its matching result. */
export async function authorityAtHub<T extends AuthorityRelayRequest>(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  request: T,
): Promise<Extract<AuthorityRelayResponse, { op: T['op'] }>> {
  let response: Response;
  try {
    response = await fetch(new URL(`/teams/${slug}/sync/authority`, enrollment.hub_url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollment.credential}`,
      },
      body: JSON.stringify(AuthorityRelayRequestSchema.parse(request)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn({
      msg: 'sync_authority_hub_unreachable',
      team: slug,
      op: request.op,
      err: String(err),
      code: failureCode(err),
    });
    throw await diagnoseHubFailure(enrollment.hub_url, err);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = ErrorBodySchema.safeParse(body);
    if (error.success && ERROR_HTTP_STATUS[error.data.error.code] === response.status) {
      throw new MusterdError(error.data.error.code, error.data.error.message);
    }
    throw new Error(`the hub answered ${response.status} to authority relay ${request.op}`);
  }
  const result = AuthorityRelayResponseSchema.parse(body);
  if (result.op !== request.op)
    throw new Error(`the hub returned a mismatched authority relay result`);
  return result as Extract<AuthorityRelayResponse, { op: T['op'] }>;
}
