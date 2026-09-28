import { randomBytes } from 'node:crypto';
import { isMusterdCredential } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { MusterdError } from '../errors.js';
import { addMember, getMemberByName, hashToken, memberStandingRefusal } from './members.js';
import type { MemberRow, TeamRow } from './rows.js';
import { resolveAccountStatus, resolveCapabilities } from './rows.js';

/**
 * Member-created agents (ADR 449 §3–4). A human member mints an agent seat the way `musterd agent`
 * does on the team side — a real agent-kind member with its own name, role and roster row — and
 * gets back a one-time connect nonce instead of a secret. The agent's device redeems that nonce at
 * OAuth authorize (increment 2b) for a token chain bound to the agent seat.
 *
 * Three invariants, all enforced here so no route can skip them:
 * - `sponsored_by` = the caller, so revoking them cascades (§2, `cascadeSponsoredRevocation`);
 * - the agent's `lifecycle_until` is the sponsor's, so it cannot outlive them (an unexpiring
 *   sponsor mints unexpiring agents);
 * - at most {@link SPONSORED_AGENT_CAP} live agents per sponsor.
 */

/** Live sponsored agents per sponsor. The shipped default; teams retune it through the
 *  `sponsored_agent_cap` policy (ADR 459), threaded in by the caller. */
export const SPONSORED_AGENT_CAP = 3;

/** How long a connect link lives: long enough to install a harness, short enough to be inert. */
export const CONNECT_NONCE_TTL_MS = 15 * 60 * 1000;

export interface AgentConnectNonce {
  nonce: string;
  expires_at: number;
}

/**
 * Issue a fresh connect nonce for `memberId`, burning any unused one it had — one live link per
 * agent, so a re-issue is also how a sponsor kills a link they sent to the wrong place. `issuedBy`
 * is who asked for it (ADR 456 §3): it travels onto the chain as `connected_by` and bounds it.
 * Callers authorize first with {@link connectRefusal}.
 */
export function issueAgentConnectNonce(
  db: Database,
  teamId: string,
  memberId: string,
  issuedBy: string,
  now = Date.now(),
): AgentConnectNonce {
  const nonce = mintConnectNonce();
  const expires_at = now + CONNECT_NONCE_TTL_MS;
  db.transaction(() => {
    db.prepare(
      'UPDATE agent_connect_nonces SET used_at = ? WHERE member_id = ? AND used_at IS NULL',
    ).run(now, memberId);
    db.prepare(
      `INSERT INTO agent_connect_nonces
         (nonce_hash, team_id, member_id, issued_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(hashToken(nonce), teamId, memberId, issuedBy, now, expires_at);
  })();
  return { nonce, expires_at };
}

/**
 * 256 random bits, base64url — redrawn in the (~1e-7) case it begins with a credential prefix, so
 * the consent page's "no credential anywhere" refusal (ADR 452 §1) can never refuse a real link.
 * `draw` is a test seam.
 */
export function mintConnectNonce(draw: () => Buffer = () => randomBytes(32)): string {
  for (;;) {
    const nonce = draw().toString('base64url');
    if (!isMusterdCredential(nonce)) return nonce;
  }
}

/**
 * Why `caller` may NOT issue a connect link for `agent` under the team's `agent_connect` policy
 * (ADR 456 §2), or null when they may. The one statement of the rule, shared by the HTTP route and
 * the remote `team_agent_connect` tool. `'sponsor'`: the sponsor or an admin. `'any_member'`: any
 * human member. Agents never issue; only a live sponsored agent is connectable (ADR 452).
 */
export function connectRefusal(
  caller: MemberRow,
  agent: MemberRow | undefined,
  policy: 'sponsor' | 'any_member',
  teamSlug: string,
  opts: { hosted?: string | null } = {},
): MusterdError | null {
  if (caller.kind !== 'human' || caller.observer === 1)
    return new MusterdError('forbidden', 'only a human member can connect an agent (ADR 456 §2)');
  const s = agent ? resolveAccountStatus(agent) : null;
  if (
    !agent ||
    agent.kind !== 'agent' ||
    agent.left_at !== null ||
    agent.sponsored_by === null ||
    s === 'disabled' ||
    s === 'banned' ||
    s === 'archived'
  )
    return new MusterdError(
      'not_found',
      `no connectable agent by that name in ${teamSlug} — only live member-created agents connect over OAuth`,
    );
  // ADR 463 §4.1: a hosted agent is never OAuth-connectable, by anyone, under either policy — the
  // link and the host would occupy one seat, and `any_member` would make every member a way in.
  if (opts.hosted)
    return new MusterdError(
      'conflict',
      `"${agent.name}" is hosted on ${opts.hosted} — it runs there, not over a connect link; unenroll it first (musterd residency off)`,
    );
  if (policy === 'any_member') return null;
  if (agent.sponsored_by === caller.id || resolveCapabilities(caller).is_admin) return null;
  return new MusterdError(
    'forbidden',
    `on ${teamSlug} only an agent's sponsor or an admin can connect it (team policy agent_connect: sponsor)`,
  );
}

/** Live (not left, not disabled/banned/archived) agents this sponsor has minted. */
export function liveSponsoredAgents(db: Database, teamId: string, sponsorId: string): MemberRow[] {
  return db
    .prepare<[string, string], MemberRow>(
      'SELECT * FROM members WHERE team_id = ? AND sponsored_by = ? AND left_at IS NULL',
    )
    .all(teamId, sponsorId)
    .filter((m) => {
      const s = resolveAccountStatus(m);
      return s !== 'disabled' && s !== 'banned' && s !== 'archived';
    });
}

export function createSponsoredAgent(
  db: Database,
  team: TeamRow,
  sponsor: MemberRow,
  input: { name: string; role?: string | null | undefined },
  now = Date.now(),
  opts: { cap?: number } = {},
): { member: MemberRow } & AgentConnectNonce {
  if (sponsor.kind !== 'human' || sponsor.observer === 1)
    throw new MusterdError('forbidden', 'only a human member can create agents (ADR 449 §3)');
  // ADR 459 §1: an admin can narrow one member's minting through capabilities without touching
  // anyone else's. Default true (generalist), so this fires only where an admin chose it.
  if (resolveCapabilities(sponsor).can_create_agents === false)
    throw new MusterdError(
      'forbidden',
      'an admin turned off agent creation for this seat (capability can_create_agents) — ask them to re-enable it',
    );
  const cap = opts.cap ?? SPONSORED_AGENT_CAP;
  return db.transaction(() => {
    // `addMember` would *revive* a tombstoned name — row, history and all. A sponsored mint must
    // never inherit someone else's past, so a removed name is refused here, not revived.
    const existing = getMemberByName(db, team.id, input.name);
    if (existing && existing.left_at !== null)
      throw new MusterdError(
        'conflict',
        `"${input.name}" was used by a removed member of "${team.slug}" — pick another name`,
      );
    const live = liveSponsoredAgents(db, team.id, sponsor.id);
    if (live.length >= cap)
      throw new MusterdError(
        'forbidden',
        `you already have ${live.length} live agents (the cap of ${cap} per member) — ` +
          `remove one first: ${live.map((m) => m.name).join(', ')}`,
      );
    const expiring = sponsor.lifecycle === 'until' && sponsor.lifecycle_until !== null;
    const { row } = addMember(db, team, {
      name: input.name,
      kind: 'agent',
      role: input.role ?? '',
      sponsoredBy: sponsor.id,
      ...(expiring ? { lifecycle: 'until' as const, lifecycleUntil: sponsor.lifecycle_until } : {}),
    });
    return { member: row, ...issueAgentConnectNonce(db, team.id, row.id, sponsor.id, now) };
  })();
}

/**
 * Redeem a connect nonce exactly once, returning the agent it names and who issued it — or null for anything a
 * stranger would also get null for: unknown, used, expired, wrong team, or an agent that has since
 * left or been disabled. A wrong-team attempt does not burn it.
 */
export function redeemAgentConnectNonce(
  db: Database,
  teamId: string,
  nonce: string,
  now = Date.now(),
): { agent: MemberRow; issuedBy: MemberRow } | null {
  return db.transaction(() => {
    const row = db
      .prepare<
        [string],
        {
          team_id: string;
          member_id: string;
          issued_by: string;
          expires_at: number;
          used_at: number | null;
        }
      >(
        'SELECT team_id, member_id, issued_by, expires_at, used_at FROM agent_connect_nonces WHERE nonce_hash = ?',
      )
      .get(hashToken(nonce));
    if (!row || row.team_id !== teamId || row.used_at !== null) return null;
    db.prepare('UPDATE agent_connect_nonces SET used_at = ? WHERE nonce_hash = ?').run(
      now,
      hashToken(nonce),
    );
    if (row.expires_at <= now) return null;
    const member = db
      .prepare<
        [string, string],
        MemberRow
      >("SELECT * FROM members WHERE team_id = ? AND id = ? AND left_at IS NULL AND kind = 'agent'")
      .get(teamId, row.member_id);
    if (!member) return null;
    const s = resolveAccountStatus(member);
    if (s === 'disabled' || s === 'banned' || s === 'archived') return null;
    // ADR 463 §4.1: a link issued before the agent was hosted redeems nothing once it is.
    if (
      db
        .prepare<
          [string, string],
          { one: number }
        >('SELECT 1 AS one FROM residency WHERE team_id = ? AND member_id = ?')
        .get(teamId, member.id)
    )
      return null;
    // ADR 456 §3: the issuer bounds the session, so an issuer who has since lost standing redeems
    // nothing — the chain would be dead on its first use anyway.
    const issuedBy = db
      .prepare<[string], MemberRow>('SELECT * FROM members WHERE id = ?')
      .get(row.issued_by);
    if (!issuedBy || memberStandingRefusal(issuedBy, now)) return null;
    return { agent: member, issuedBy };
  })();
}
