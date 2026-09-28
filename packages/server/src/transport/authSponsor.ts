import type { Database } from 'better-sqlite3';
import { MusterdError } from '../errors.js';
import { getMemberByName, memberStandingRefusal } from '../store/members.js';
import {
  type MemberRow,
  resolveAccountStatus,
  resolveCapabilities,
  type TeamRow,
} from '../store/rows.js';

/**
 * ADR 463 §1: the caller may act as a sponsor at all — a live human in good standing whose
 * `can_create_agents` an admin has not withdrawn. Hosting is gated by the same switch as creating.
 */
export function assertSponsorCaller(member: MemberRow, now = Date.now()): void {
  if (member.kind !== 'human' || member.observer === 1)
    throw new MusterdError(
      'forbidden',
      'only a human member acts for the agents they sponsor (ADR 463 §1)',
    );
  const standing = memberStandingRefusal(member, now);
  if (standing) throw standing;
  if (resolveCapabilities(member).can_create_agents === false)
    throw new MusterdError(
      'forbidden',
      'an admin turned off agent creation (and hosting) for this seat (capability can_create_agents)',
    );
}

/**
 * ADR 463 §1: a member's authority over the agents they sponsor — and nothing else. Returns the
 * agent. A name that is not a live agent is `not_found` (a removed or disabled agent is never
 * minted for, Review Focus 4); a live agent someone else sponsors — or nobody does — is `forbidden`.
 */
export function assertSponsorOf(
  db: Database,
  team: TeamRow,
  member: MemberRow,
  agentName: string,
  now = Date.now(),
): MemberRow {
  assertSponsorCaller(member, now);
  const agent = getMemberByName(db, team.id, agentName);
  const status = agent ? resolveAccountStatus(agent) : null;
  if (
    !agent ||
    agent.kind !== 'agent' ||
    agent.left_at !== null ||
    status === 'disabled' ||
    status === 'banned' ||
    status === 'archived'
  )
    throw new MusterdError('not_found', `no live agent "${agentName}" in "${team.slug}"`);
  if (agent.sponsored_by !== member.id)
    throw new MusterdError('forbidden', `"${agentName}" is not an agent you sponsor`);
  return agent;
}
