import { makeEnvelope } from '@musterd/protocol';
import { ulid } from 'ulid';
import { resolveRosterRoots } from '../config.js';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { teamSpecForSlug } from '../projection/reconcile.js';
import { routeEnvelope } from '../protocol/route.js';
import { appendAudit } from '../store/audit.js';
import { getMemberByName } from '../store/members.js';
import { getResidency } from '../store/residency.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import {
  connectRefusal,
  createSponsoredAgent,
  issueAgentConnectNonce,
} from '../store/sponsoredAgents.js';
import { getPolicy } from '../store/teams.js';
import { broadcastMemberAdded } from './memberAdded.js';

/**
 * The one mint path for member-created agents (ADR 449 §3), shared by `POST …/members/agents` and
 * the remote `team_agent_create` tool so the two surfaces cannot drift: the file-backed refusal,
 * the store's invariants (human-only, inherited expiry, cap, no revived names), the audit row, the
 * team notice, and the connect link.
 */
export function mintSponsoredAgent(
  ctx: Ctx,
  team: TeamRow,
  sponsor: MemberRow,
  input: { name: string; role?: string | null | undefined },
  origin: string,
): { member: MemberRow; connect_url: string; connect_expires_at: number } {
  // A file-backed team's seat files are the single writer (ADR 058): a db-originated seat would be
  // double-sourced there. Member-created agents need a team whose roster lives in the daemon.
  if (teamSpecForSlug([...new Set([...ctx.rosterRoots, ...resolveRosterRoots()])], team.slug))
    throw new MusterdError(
      'forbidden',
      `"${team.slug}" keeps its roster in seat files — add an agent there (\`musterd agent\`); ` +
        'member-created agents need a team whose roster lives in the daemon',
    );
  const { member, nonce, expires_at } = createSponsoredAgent(
    ctx.db,
    team,
    sponsor,
    input,
    Date.now(),
    {
      cap: getPolicy(ctx.db, team.id).sponsored_agent_cap,
    },
  );
  appendAudit(ctx.db, team.id, {
    actor: sponsor.name,
    action: 'member.sponsored_agent_created',
    target: member.name,
    result: 'allow',
    detail: { lifecycle_until: member.lifecycle_until },
  });
  announceAgentCreated(ctx, team, sponsor, member);
  broadcastMemberAdded(ctx.hub, team.id, member.name);
  return {
    member,
    connect_url: agentConnectUrl(origin, team.slug, nonce),
    connect_expires_at: expires_at,
  };
}

/**
 * Issue a connect link for a live sponsored agent (ADR 456 §2), shared by
 * `POST …/members/agents/:name/connect` and the remote `team_agent_connect` tool: the team's
 * `agent_connect` policy decides who may (`connectRefusal`), the issuer is recorded on the nonce so
 * it bounds the session it starts (§3), and the issue is audited with the issuer as actor (§4).
 */
export function issueAgentConnect(
  ctx: Ctx,
  team: TeamRow,
  caller: MemberRow,
  agentName: string,
  origin: string,
): { member: string; connect_url: string; connect_expires_at: number } {
  const agent = getMemberByName(ctx.db, team.id, agentName);
  const hosted = agent ? (getResidency(ctx.db, team.id, agent.id)?.host ?? null) : null;
  const refusal = connectRefusal(
    caller,
    agent,
    getPolicy(ctx.db, team.id).agent_connect,
    team.slug,
    { hosted },
  );
  if (refusal) throw refusal;
  const { nonce, expires_at } = issueAgentConnectNonce(ctx.db, team.id, agent!.id, caller.id);
  appendAudit(ctx.db, team.id, {
    actor: caller.name,
    action: 'member.agent_connect_issued',
    target: agent!.name,
    result: 'allow',
    detail: { sponsor_is_caller: agent!.sponsored_by === caller.id },
  });
  return {
    member: agent!.name,
    connect_url: agentConnectUrl(origin, team.slug, nonce),
    connect_expires_at: expires_at,
  };
}

/**
 * Tell the team a member created an agent (lane 01M3FBK3S6). Before this the mint wrote only an
 * audit row, so a new seat appeared on the roster with nobody told who made it. One `@team`
 * `message` in the sponsor's own voice, so /live and every inbox show it as ordinary traffic;
 * `meta.agent_created` lets a surface key off it without parsing the body. Daemon-composed (ADR 225)
 * because the server wrote it, not a client. Only a successful mint reaches here: a refused one
 * threw in `createSponsoredAgent` above and announces nothing.
 */
function announceAgentCreated(ctx: Ctx, team: TeamRow, sponsor: MemberRow, agent: MemberRow): void {
  routeEnvelope(
    ctx,
    team,
    sponsor,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: sponsor.name,
      to: { kind: 'team' },
      act: 'message',
      body: `${sponsor.name} created agent ${agent.name}`,
      meta: { agent_created: { agent: agent.name, sponsor: sponsor.name } },
    }),
    undefined,
    true,
  );
}

/**
 * ADR 449 §4 / ADR 170: the nonce rides the fragment — never sent to a server, never logged. One
 * join page per team (ADR 450 shares it): the fragment key dispatches — `n=` an agent connect,
 * `i=` a human invite.
 */
export function agentConnectUrl(origin: string, slug: string, nonce: string): string {
  return `${origin}/join/${encodeURIComponent(slug)}#n=${nonce}`;
}

/** The public origin as the client saw it — the tunnel's `x-forwarded-proto` and the Host header. */
export function originFrom(
  host: string | null | undefined,
  proto: string | null | undefined,
): string {
  const first = proto?.split(',')[0]?.trim().toLowerCase();
  return `${first === 'https' ? 'https' : 'http'}://${host ?? 'localhost'}`;
}
