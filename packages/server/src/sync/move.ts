import {
  type MoveProvisionStatus,
  MoveProvisionStatusSchema,
  type SeatMoved,
  SeatMovedSchema,
  type SyncMoveRequest,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { log } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { revokeGrant } from '../store/grants.js';
import { insertProvision } from '../store/hostProvisions.js';
import { memberStandingRefusal } from '../store/members.js';
import { moveSeatBinding, resolveNodeRef, seatBindings } from '../store/nodes.js';
import { HOST_STALE_MS, parsePolicyOverride, revokeResidency } from '../store/residency.js';
import { type MemberRow, resolveCapabilities } from '../store/rows.js';
import { assertSponsorCaller } from '../transport/authSponsor.js';
import { HubUnreachableError, TrustRefusedError, assertSeatAlreadyResident } from './claim.js';

/** The forward's bound — the claim's (`sync/claim.ts`): a hub that has not answered in 10 s is down. */
const MOVE_TIMEOUT_MS = 10_000;

/**
 * ADR 696, the move itself — runs wherever the binding lives: on the hub for a forwarded request,
 * on a single-machine daemon for its own seats. `speaker` is the machine the mover is acting from
 * (the hub's authenticated joiner, or the local row).
 *
 * Who may move what (ADR 696 §2):
 *  - an agent: a team admin, the agent's sponsor, or the agent itself;
 *  - a human: only that person, and only from a machine already in their set — ADR 358's rule, so
 *    an admin credential presented from a fresh machine cannot widen anyone's set.
 *
 * Authority is decided before the write; the write is one transaction — the binding is replaced
 * (never unbound, then bound), the seat's wake enrollment is revoked, and both are audited. The
 * `residency.revoked` row is the one joiners already fold (ADR 393), so the old host stops leasing
 * the seat on every daemon, not just this one.
 */
export async function applyMove(
  db: Driver,
  teamId: string,
  input: {
    seat: MemberRow;
    actor: MemberRow;
    speaker: { id: string; label: string };
    to: string;
    only?: boolean;
    now?: number;
    /**
     * ADR 703: the caller passed `--to`. When a host on the target polled within
     * `HOST_STALE_MS`, the destination half is a `kind: 'move'` provision pinned to it.
     * Otherwise nothing is queued and the CLI prints the finish.
     */
    handToHost?: boolean;
    /** This daemon's own node, so a host that only ever polled locally still counts as here. */
    homeNodeId?: string;
  },
): Promise<SeatMoved> {
  const { seat, actor, speaker } = input;
  const now = input.now ?? Date.now();
  if (seat.left_at !== null) throw new MusterdError('not_found', `no seat "${seat.name}"`);
  // The mover's standing, on every branch: a forwarded move names its actor by string, and a seat
  // that has left, is halted or banned, or only observes moves nothing — admin or not.
  const standing = memberStandingRefusal(actor, now);
  if (standing) throw standing;
  if (actor.observer === 1)
    throw new MusterdError(
      'forbidden',
      `"${actor.name}" is an observer — an observer moves no seat`,
    );
  if (seat.kind !== 'agent' && seat.kind !== 'human')
    throw new MusterdError(
      'forbidden',
      `"${seat.name}" is a ${seat.kind} seat — a service belongs to the machine that runs it; ` +
        'install it on the new machine instead (musterd service install)',
    );
  if (seat.kind === 'human') {
    if (actor.id !== seat.id)
      throw new MusterdError(
        'forbidden',
        `"${seat.name}" is a person's seat — only ${seat.name} may add a machine to it, from a ` +
          'machine they already use (ADR 358); an admin cannot move it',
      );
    await assertSeatAlreadyResident(db, teamId, seat, speaker, 'move');
  } else if (actor.id !== seat.id && !resolveCapabilities(actor).is_admin) {
    if (seat.sponsored_by !== actor.id)
      throw new MusterdError(
        'forbidden',
        `moving "${seat.name}" takes a team admin, its sponsor, or ${seat.name} itself (ADR 696)`,
      );
    assertSponsorCaller(actor, now);
  }

  const target = await resolveNodeRef(db, teamId, input.to);
  if (!target.ok) {
    throw new MusterdError(
      target.reason === 'ambiguous' ? 'conflict' : 'not_found',
      target.reason === 'ambiguous'
        ? `"${input.to}" names more than one machine — name one by its node id: ${target.candidates.join(', ')}`
        : `no enrolled machine "${input.to}" on this team — enroll it first (musterd node invite / ` +
            `join)${target.candidates.length ? `; known: ${target.candidates.join(', ')}` : ''}`,
    );
  }
  const to = target.node;

  return await db.tx(async (t) => {
    const before = await seatBindings(t, seat.id);
    await moveSeatBinding(t, teamId, seat, to.id, { now, ...(input.only ? { only: true } : {}) });
    // A person gaining a machine keeps their wake enrollment; an agent's moves with it.
    const removed = seat.kind === 'agent' ? await revokeResidency(t, teamId, seat.id) : null;
    if (removed) {
      if (removed.grant_id) await revokeGrant(t, teamId, removed.grant_id);
      await appendAudit(t, teamId, {
        actor: actor.name,
        action: 'residency.revoked',
        target: seat.name,
        result: 'allow',
        detail: {
          host: removed.host,
          ...(removed.grant_id ? { grant_id: removed.grant_id } : {}),
          authorized_by: actor.name,
          moved_to: to.label,
        },
      });
    }
    const residency = removed
      ? {
          harness: removed.harness,
          host: removed.host,
          policy: parsePolicyOverride(removed.policy),
        }
      : null;
    await appendAudit(t, teamId, {
      actor: actor.name,
      action: 'seat.moved',
      target: seat.name,
      result: 'allow',
      detail: {
        from: before.map((b) => b.node_id),
        to: to.id,
        to_label: to.label,
        by: actor.name,
        by_node: speaker.id,
        residency: removed ? removed.host : null,
      },
    });
    // An agent sent with --to, and a host on that machine heard from inside the staleness
    // window: the host stands the Workspace up. A person still finishes with `musterd human`,
    // which needs their own credential. No live host: the CLI prints the finish (ADR 703).
    let provision: SeatMoved['provision'];
    if (input.handToHost && seat.kind === 'agent') {
      const host = await liveHostOnNode(t, teamId, to.id, input.homeNodeId, now);
      if (host) {
        const move = residency
          ? { harness: residency.harness, policy: residency.policy }
          : { harness: 'claude-code', policy: null };
        const row = await insertProvision(
          t,
          teamId,
          seat.id,
          actor.id,
          now,
          null,
          host,
          'move',
          JSON.stringify(move),
        );
        await appendAudit(t, teamId, {
          actor: null,
          action: 'host.provision_pending',
          target: row.id,
          result: 'allow',
          detail: {
            agent: seat.name,
            sponsor: actor.name,
            host,
            connect_origin: null,
            created_at: now,
            kind: 'move',
            move,
          },
        });
        provision = { id: row.id, host };
      }
    }
    return {
      seat: seat.name,
      kind: seat.kind as 'agent' | 'human',
      from: before.map((b) => ({ node_id: b.node_id, label: b.label })),
      to: { node_id: to.id, label: to.label },
      residency,
      ...(provision ? { provision } : {}),
    };
  });
}

/**
 * A host label bound to `nodeId` that polled within `HOST_STALE_MS`. A label that only ever
 * polled on this daemon has no node binding; it counts when the target is this daemon's node.
 */
async function liveHostOnNode(
  db: Driver,
  teamId: string,
  nodeId: string,
  homeNodeId: string | undefined,
  now: number,
): Promise<string | null> {
  const here = homeNodeId !== undefined && homeNodeId === nodeId ? 1 : 0;
  const row = await db.get<{ host: string }>(
    `SELECT host FROM host_liveness
      WHERE team_id = ? AND seen_at >= ?
        AND (node = ? OR (? = 1 AND node IS NULL))
      ORDER BY seen_at DESC LIMIT 1`,
    [teamId, now - HOST_STALE_MS, nodeId, here],
  );
  return row?.host ?? null;
}

/**
 * Joiner side of the move: ask the hub, write nothing. The binding is the hub's fact (ADR 509 rides
 * it back on the pull page). Refusals relay with the hub's code, the `trustAtHub` rule.
 */
export async function moveAtHub(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  req: SyncMoveRequest,
): Promise<SeatMoved> {
  let res: Response;
  try {
    res = await fetch(new URL(`/teams/${slug}/sync/move`, enrollment.hub_url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollment.credential}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(MOVE_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ msg: 'sync_move_hub_unreachable', team: slug, seat: req.seat, err: String(err) });
    throw new HubUnreachableError(enrollment.hub_url, String(err));
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const b = body as {
      error?: { code?: string; message?: string };
      node_id?: string;
      node_label?: string;
    } | null;
    const code = b?.error?.code;
    if (code === 'bound_elsewhere')
      throw new TrustRefusedError(
        code,
        b?.error?.message ?? '',
        b?.node_id ?? null,
        b?.node_label ?? null,
      );
    if (code === 'forbidden' || code === 'not_found' || code === 'conflict')
      throw new MusterdError(code, b?.error?.message ?? `the hub refused the move (${res.status})`);
    throw new Error(`the hub answered ${res.status} to the move: ${JSON.stringify(body)}`);
  }
  return SeatMovedSchema.parse(body);
}

/** ADR 703: the joiner reads a move provision the hub wrote. The id is the only secret, and it is a ULID. */
export async function provisionStatusAtHub(
  enrollment: { hub_url: string; credential: string },
  slug: string,
  id: string,
): Promise<MoveProvisionStatus> {
  let res: Response;
  try {
    res = await fetch(new URL(`/teams/${slug}/sync/provision-status`, enrollment.hub_url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${enrollment.credential}`,
      },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(MOVE_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ msg: 'sync_provision_status_hub_unreachable', team: slug, id, err: String(err) });
    throw new HubUnreachableError(enrollment.hub_url, String(err));
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const b = body as { error?: { code?: string; message?: string } } | null;
    const code = b?.error?.code;
    if (code === 'not_found')
      throw new MusterdError('not_found', b?.error?.message ?? 'no provision');
    throw new Error(`the hub answered ${res.status} to the provision: ${JSON.stringify(body)}`);
  }
  return MoveProvisionStatusSchema.parse(body);
}
