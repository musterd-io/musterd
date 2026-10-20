import { makeEnvelope, type SponsoredAgentHosting } from '@musterd/protocol';
import { ulid } from 'ulid';
import { resolveRosterRoots } from '../config.js';
import type { Ctx } from '../context.js';
import { MusterdError } from '../errors.js';
import { teamSpecForSlug } from '../projection/reconcile.js';
import { routeEnvelope } from '../protocol/route.js';
import { appendAudit } from '../store/audit.js';
import { revokeGrant } from '../store/grants.js';
import { insertProvision, sponsorHostsSeen, sweepProvisions } from '../store/hostProvisions.js';
import { getMemberById, getMemberByName } from '../store/members.js';
import { getResidency, revokeResidency } from '../store/residency.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import {
  connectRefusal,
  createSponsoredAgent,
  issueAgentConnectNonce,
} from '../store/sponsoredAgents.js';
import { getPolicy, getTeamById } from '../store/teams.js';
import { broadcastMemberAdded } from './memberAdded.js';

/**
 * The one mint path for member-created agents (ADR 449 §3), behind `POST …/members/agents` — which
 * the adapter's remote `team_agent_create` calls (ADR 630), so there is one surface: the file-backed refusal,
 * the store's invariants (human-only, inherited expiry, cap, no revived names), the audit row, the
 * team notice, and the connect link.
 */
export async function mintSponsoredAgent(
  ctx: Ctx,
  team: TeamRow,
  sponsor: MemberRow,
  input: { name: string; role?: string | null | undefined; host?: string | null | undefined },
  origin: string,
): Promise<{
  member: MemberRow;
  hosting: SponsoredAgentHosting;
  /** The sponsor's host label that will run it, when `hosting` is `sponsor_host`. */
  host: string | null;
  connect_url: string;
  connect_expires_at: number;
}> {
  // A file-backed team's seat files are the single writer (ADR 058): a db-originated seat would be
  // double-sourced there. Member-created agents need a team whose roster lives in the daemon.
  if (teamSpecForSlug([...new Set([...ctx.rosterRoots, ...resolveRosterRoots()])], team.slug))
    throw new MusterdError(
      'forbidden',
      `"${team.slug}" keeps its roster in seat files — add an agent there (\`musterd agent\`); ` +
        'member-created agents need a team whose roster lives in the daemon',
    );
  // A named host (`musterd agent --hosted --host <label>`, lane 01M5DR34Y2) pins the row to that
  // label; checked BEFORE the member exists, so a refusal leaves no seat behind; it must be one of the sponsor's hosts seen in the window, else the mint is refused with
  // the labels that were. Unnamed keeps the original shape: the newest-seen host, any host claims.
  const seen = await sponsorHostsSeen(ctx.db, team.id, sponsor.id);
  const wanted = input.host ?? null;
  if (wanted !== null && !seen.includes(wanted)) {
    throw new MusterdError(
      'conflict',
      `host "${wanted}" is not a host of yours that polled in the last 10 minutes` +
        (seen.length > 0 ? ` (seen: ${seen.join(', ')})` : ' (none seen)') +
        ' — start it, or name one of those',
    );
  }
  const { member, nonce, expires_at } = await createSponsoredAgent(
    ctx.db,
    team,
    sponsor,
    input,
    Date.now(),
    {
      cap: (await getPolicy(ctx.db, team.id)).sponsored_agent_cap,
    },
  );
  await appendAudit(ctx.db, team.id, {
    actor: sponsor.name,
    action: 'member.sponsored_agent_created',
    target: member.name,
    result: 'allow',
    detail: { lifecycle_until: member.lifecycle_until },
  });
  await announceAgentCreated(ctx, team, sponsor, member);
  broadcastMemberAdded(ctx.hub, team.id, member.name);
  // ADR 463 §2: a sponsor whose own host key polled in the last 10 minutes gets the agent stood up
  // there — one pending provision that host claims. Otherwise nothing is queued and the connect
  // link below is the way in. The link is returned either way; a caller leads with whichever applies.
  const host = wanted ?? seen[0] ?? null;
  const hosting: SponsoredAgentHosting = host !== null ? 'sponsor_host' : 'connect_link';
  if (host !== null)
    await insertProvision(ctx.db, team.id, member.id, sponsor.id, Date.now(), origin, wanted);
  return {
    member,
    hosting,
    host,
    connect_url: agentConnectUrl(origin, team.slug, nonce),
    connect_expires_at: expires_at,
  };
}

/**
 * Issue a connect link for a live sponsored agent (ADR 456 §2), behind
 * `POST …/members/agents/:name/connect` (the adapter's remote `team_agent_connect` calls it): the team's
 * `agent_connect` policy decides who may (`connectRefusal`), the issuer is recorded on the nonce so
 * it bounds the session it starts (§3), and the issue is audited with the issuer as actor (§4).
 */
export async function issueAgentConnect(
  ctx: Ctx,
  team: TeamRow,
  caller: MemberRow,
  agentName: string,
  origin: string,
): Promise<{ member: string; connect_url: string; connect_expires_at: number }> {
  const agent = await getMemberByName(ctx.db, team.id, agentName);
  const hosted = agent ? ((await getResidency(ctx.db, team.id, agent.id))?.host ?? null) : null;
  const refusal = connectRefusal(
    caller,
    agent,
    (await getPolicy(ctx.db, team.id)).agent_connect,
    team.slug,
    { hosted },
  );
  if (refusal) throw refusal;
  const { nonce, expires_at } = await issueAgentConnectNonce(ctx.db, team.id, agent!.id, caller.id);
  await appendAudit(ctx.db, team.id, {
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
async function announceAgentCreated(
  ctx: Ctx,
  team: TeamRow,
  sponsor: MemberRow,
  agent: MemberRow,
): Promise<void> {
  await routeEnvelope(
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

/** How often the daemon settles provisions that can no longer finish (ADR 463 §2). */
export const PROVISION_CANCEL_INTERVAL_MS = 60 * 1000;

/**
 * Tell a sponsor what became of an agent's provision. The agent's own seat is the sender: the
 * sponsor's inbox never shows the sponsor's own acts, and the news is about that agent.
 * Daemon-composed from structured fields; `meta` lets a surface key off it without parsing.
 */
export async function tellSponsorOfProvision(
  ctx: Ctx,
  team: TeamRow,
  agent: MemberRow,
  sponsorName: string,
  body: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await routeEnvelope(
    ctx,
    team,
    agent,
    makeEnvelope({
      id: ulid(),
      team: team.slug,
      from: agent.name,
      to: { kind: 'member', name: sponsorName },
      act: 'message',
      body,
      meta,
    }),
    undefined,
    true,
  );
}

/**
 * A provision that failed leaves no half-hosted seat behind: a host that enrolled the seat before it
 * failed (or before it went quiet) has that enrollment and its standing grant revoked, so the
 * connect link the sponsor gets next can redeem (ADR 463 §4.1 refuses a hosted agent's link).
 */
export async function unhostFailedProvision(
  ctx: Ctx,
  team: TeamRow,
  agent: MemberRow,
  reason: string,
): Promise<void> {
  const removed = await revokeResidency(ctx.db, team.id, agent.id);
  if (!removed) return;
  if (removed.grant_id) await revokeGrant(ctx.db, team.id, removed.grant_id);
  await appendAudit(ctx.db, team.id, {
    actor: null,
    action: 'residency.revoked',
    target: agent.name,
    result: 'allow',
    detail: {
      host: removed.host,
      ...(removed.grant_id ? { grant_id: removed.grant_id } : {}),
      provision_failed: reason,
    },
  });
}

/**
 * One sweep pass (ADR 463 §2, `sweepProvisions`): every open provision that can no longer finish is
 * settled and audited. A sponsor still in standing gets one message carrying a fresh connect link,
 * issued in their name — nothing is stuck waiting on a host that never came or never reported.
 */
export async function sweepProvisionsPass(ctx: Ctx, now = Date.now()): Promise<number> {
  const swept = await sweepProvisions(ctx.db, now);
  for (const { row, reason } of swept) {
    const team = await getTeamById(ctx.db, row.team_id);
    const agent = await getMemberById(ctx.db, row.member_id);
    const sponsor = await getMemberById(ctx.db, row.sponsor_id);
    if (!team || !agent) continue;
    await appendAudit(ctx.db, team.id, {
      actor: null,
      action: row.state === 'cancelled' ? 'host.provision_cancelled' : 'host.provision_failed',
      target: row.id,
      result: 'deny',
      detail: { agent: agent.name, reason, ...(row.host ? { host: row.host } : {}) },
    });
    if (reason === 'agent_left' || reason === 'sponsor_lost_standing' || !sponsor) continue;
    if (reason === 'not_reported') await unhostFailedProvision(ctx, team, agent, reason);
    const { nonce } = await issueAgentConnectNonce(ctx.db, team.id, agent.id, sponsor.id, now);
    const url = agentConnectUrl(row.connect_origin ?? originFrom(null, null), team.slug, nonce);
    const what =
      reason === 'unclaimed'
        ? `No host of yours picked up ${agent.name} within 15 minutes.`
        : `Your host ${row.host} took ${agent.name} but never said it was ready.`;
    await tellSponsorOfProvision(
      ctx,
      team,
      agent,
      sponsor.name,
      `${what} Open this link on the device that will run it (expires in 15 minutes, works once): ${url}`,
      { agent_connect_fallback: { agent: agent.name, reason } },
    );
  }
  return swept.length;
}

/** The daemon's provision sweep loop; a failing pass logs and the loop keeps running. */
export function startProvisionSweep(ctx: Ctx, onError: (err: unknown) => void): () => void {
  const every = setInterval(async () => {
    try {
      await sweepProvisionsPass(ctx);
    } catch (err) {
      onError(err);
    }
  }, PROVISION_CANCEL_INTERVAL_MS);
  every.unref?.();
  return () => clearInterval(every);
}
