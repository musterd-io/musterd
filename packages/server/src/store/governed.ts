import {
  GovernedAuthorizationRequestSchema,
  GovernedDecisionSchema,
  GovernedLaunchAuthorizationConsumeSchema,
  GovernedLaunchAuthorizationIssueSchema,
  GovernedLaunchAuthorizationMintSchema,
  GovernedLaunchAuthorizationSchema,
  GovernedPolicySchema,
  GovernedWorkContextSchema,
  TOKEN_PREFIXES,
  type GovernedAuthorizationRequest,
  type GovernedDecision,
  type GovernedLaunchAuthorization,
  type GovernedLaunchAuthorizationConsume,
  type GovernedLaunchAuthorizationIssue,
  type GovernedLaunchAuthorizationMint,
  type GovernedPolicy,
  type GovernedRefusalCode,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { hashToken, newSecret } from './members.js';
import type { MemberRow } from './rows.js';
import { resolveAccountStatus } from './rows.js';

const LIVE_PRESENCE_DEFAULT_MS = 45_000;

interface GovernedLaunchRow {
  id: string;
  team_id: string;
  member_id: string;
  node_id: string;
  token_hash: string;
  correlation: string;
  work_context: string;
  issued_by_member_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  presence_id: string | null;
}

async function memberByName(
  db: Driver,
  teamId: string,
  name: string,
): Promise<MemberRow | undefined> {
  return await db.get<MemberRow>('SELECT * FROM members WHERE team_id = ? AND name = ?', [
    teamId,
    name,
  ]);
}

async function policyRow(
  db: Driver,
  teamId: string,
): Promise<{ policy: string; updated_at: number } | undefined> {
  return await db.get<{ policy: string; updated_at: number }>(
    'SELECT policy, updated_at FROM governed_policies WHERE team_id = ?',
    [teamId],
  );
}

export async function getGovernedPolicy(
  db: Driver,
  teamId: string,
): Promise<{ policy: GovernedPolicy; updated_at: number } | null> {
  const row = await policyRow(db, teamId);
  if (!row) return null;
  return { policy: GovernedPolicySchema.parse(JSON.parse(row.policy)), updated_at: row.updated_at };
}

export async function setGovernedPolicy(
  db: Driver,
  teamId: string,
  policy: GovernedPolicy,
  now: number = Date.now(),
): Promise<{ policy: GovernedPolicy; updated_at: number }> {
  const parsed = GovernedPolicySchema.parse(policy);
  await db.run(
    `INSERT INTO governed_policies (team_id, policy, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`,
    [teamId, JSON.stringify(parsed), now],
  );
  return { policy: parsed, updated_at: now };
}

async function launchProjection(
  db: Driver,
  row: GovernedLaunchRow,
): Promise<GovernedLaunchAuthorization> {
  const team = await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [row.team_id]);
  const member = await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [
    row.member_id,
  ]);
  const issuer = row.issued_by_member_id
    ? await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [
        row.issued_by_member_id,
      ])
    : undefined;
  if (!team || !member)
    throw new MusterdError('server_error', 'governed authorization references missing roster data');
  return GovernedLaunchAuthorizationSchema.parse({
    id: row.id,
    team: team.slug,
    member: member.name,
    node_id: row.node_id,
    correlation: row.correlation,
    context: GovernedWorkContextSchema.parse(JSON.parse(row.work_context)),
    issued_by: issuer?.name ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    revoked_at: row.revoked_at,
    presence_id: row.presence_id,
  });
}

async function requireLaunchTarget(
  db: Driver,
  teamId: string,
  input: GovernedLaunchAuthorizationIssue,
): Promise<MemberRow> {
  const member = await memberByName(db, teamId, input.member);
  if (!member) throw new MusterdError('not_found', `no governed agent Member "${input.member}"`);
  if (member.kind !== 'agent' || member.observer === 1)
    throw new MusterdError('forbidden', 'governed launches may target only an agent Member');
  const status = resolveAccountStatus(member);
  if (
    member.left_at !== null ||
    status === 'disabled' ||
    status === 'banned' ||
    status === 'archived'
  )
    throw new MusterdError('forbidden', `Member "${member.name}" is not active`);
  const binding = await db.get<{ node_id: string; revoked_at: number | null }>(
    `SELECT s.node_id, n.revoked_at FROM seat_nodes s JOIN nodes n ON n.id = s.node_id
       WHERE s.team_id = ? AND s.member_id = ? AND s.node_id = ? AND n.credential_hash IS NOT NULL`,
    [teamId, member.id, input.node_id],
  );
  if (!binding || binding.revoked_at !== null)
    throw new MusterdError(
      'forbidden',
      `Member "${member.name}" is not bound to that machine node`,
    );
  const bindings = await db.all<{ node_id: string }>(
    'SELECT node_id FROM seat_nodes WHERE member_id = ?',
    [member.id],
  );
  if (bindings.length !== 1)
    throw new MusterdError(
      'conflict',
      `agent Member "${member.name}" must have exactly one machine-node binding`,
    );
  return member;
}

export async function issueGovernedLaunch(
  db: Driver,
  teamId: string,
  issuer: MemberRow,
  rawInput: GovernedLaunchAuthorizationIssue,
  now: number = Date.now(),
): Promise<GovernedLaunchAuthorizationMint> {
  const input = GovernedLaunchAuthorizationIssueSchema.parse(rawInput);
  if (issuer.team_id !== teamId)
    throw new MusterdError('forbidden', 'governed launch issuer is not a Member of this Team');
  const issuerStatus = resolveAccountStatus(issuer);
  if (
    issuer.kind !== 'human' ||
    issuer.left_at !== null ||
    issuerStatus === 'disabled' ||
    issuerStatus === 'banned' ||
    issuerStatus === 'archived'
  )
    throw new MusterdError('forbidden', 'only an active human Member may issue a governed launch');
  const member = await requireLaunchTarget(db, teamId, input);
  const token = newSecret(TOKEN_PREFIXES.governed_launch);
  const row: GovernedLaunchRow = {
    id: ulid(),
    team_id: teamId,
    member_id: member.id,
    node_id: input.node_id,
    token_hash: hashToken(token),
    correlation: input.correlation,
    work_context: JSON.stringify(input.context),
    issued_by_member_id: issuer.id,
    created_at: now,
    expires_at: now + input.ttl_ms,
    consumed_at: null,
    revoked_at: null,
    presence_id: null,
  };
  await db.run(
    `INSERT INTO governed_launch_authorizations
      (id, team_id, member_id, node_id, token_hash, correlation, work_context,
       issued_by_member_id, created_at, expires_at, consumed_at, revoked_at, presence_id)
     VALUES (?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.team_id,
      row.member_id,
      row.node_id,
      row.token_hash,
      row.correlation,
      row.work_context,
      row.issued_by_member_id,
      row.created_at,
      row.expires_at,
      row.consumed_at,
      row.revoked_at,
      row.presence_id,
    ],
  );
  return GovernedLaunchAuthorizationMintSchema.parse({
    authorization: await launchProjection(db, row),
    token,
  });
}

export type GovernedLaunchConsumeResult =
  | { ok: true; authorization: GovernedLaunchAuthorization }
  | { ok: false; reason: GovernedRefusalCode };

export async function consumeGovernedLaunch(
  db: Driver,
  teamId: string,
  rawInput: GovernedLaunchAuthorizationConsume,
  now: number = Date.now(),
): Promise<GovernedLaunchConsumeResult> {
  const input = GovernedLaunchAuthorizationConsumeSchema.parse(rawInput);
  const row = await db.get<GovernedLaunchRow>(
    'SELECT * FROM governed_launch_authorizations WHERE team_id = ? AND id = ?',
    [teamId, input.launch_id],
  );
  if (!row) return { ok: false, reason: 'denied_launch_unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'denied_launch_revoked' };
  if (row.expires_at <= now) return { ok: false, reason: 'denied_launch_expired' };
  if (row.consumed_at !== null) return { ok: false, reason: 'denied_launch_replayed' };
  const member = await memberByName(db, teamId, input.member);
  if (
    row.token_hash !== hashToken(input.token) ||
    row.member_id !== member?.id ||
    row.node_id !== input.node_id ||
    row.correlation !== input.correlation
  )
    return { ok: false, reason: 'denied_launch_mismatch' };
  const presence = await db.get<{ member_id: string; held_until: number | null }>(
    'SELECT member_id, held_until FROM presence WHERE id = ?',
    [input.presence_id],
  );
  if (!presence) return { ok: false, reason: 'denied_presence_unknown' };
  if (presence.member_id !== member.id || presence.held_until !== null)
    return { ok: false, reason: 'denied_presence_stale' };
  const updated = await db.get<GovernedLaunchRow>(
    `UPDATE governed_launch_authorizations
       SET consumed_at = ?, presence_id = ?
       WHERE team_id = ? AND id = ? AND token_hash = ? AND consumed_at IS NULL
         AND revoked_at IS NULL AND expires_at > ?
       RETURNING *`,
    [now, input.presence_id, teamId, input.launch_id, hashToken(input.token), now],
  );
  if (!updated) return { ok: false, reason: 'denied_launch_replayed' };
  return { ok: true, authorization: await launchProjection(db, updated) };
}

export async function revokeGovernedLaunch(
  db: Driver,
  teamId: string,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (
    (
      await db.run(
        'UPDATE governed_launch_authorizations SET revoked_at = ? WHERE team_id = ? AND id = ? AND revoked_at IS NULL',
        [now, teamId, id],
      )
    ).changes > 0
  );
}

export interface GovernedNodeAuthentication {
  id: string;
  label: string;
  revoked: boolean;
}

/** Authenticate a node for governed routes while preserving the revoked-vs-unknown refusal. */
export async function authenticateGovernedNode(
  db: Driver,
  teamId: string,
  token: string,
): Promise<GovernedNodeAuthentication | null> {
  if (!token) return null;
  const row = await db.get<{ id: string; label: string; revoked_at: number | null }>(
    'SELECT id, label, revoked_at FROM nodes WHERE team_id = ? AND credential_hash = ?',
    [teamId, hashToken(token)],
  );
  return row ? { id: row.id, label: row.label, revoked: row.revoked_at !== null } : null;
}

function deny(input: GovernedAuthorizationRequest, reason: GovernedRefusalCode): GovernedDecision {
  return GovernedDecisionSchema.parse({
    decision: 'deny',
    reason,
    launch_id: input.launch_id,
    correlation: input.correlation,
    member: input.member,
    node_id: input.node_id,
    provider: input.provider,
    model: input.model,
  });
}

export async function authorizeGovernedRequest(
  db: Driver,
  teamId: string,
  nodeCredential: string,
  rawInput: GovernedAuthorizationRequest,
  options: { now?: number; livePresenceMs?: number } = {},
): Promise<GovernedDecision> {
  const input = GovernedAuthorizationRequestSchema.parse(rawInput);
  const now = options.now ?? Date.now();
  const node = await authenticateGovernedNode(db, teamId, nodeCredential);
  if (!node) return deny(input, 'denied_node_unknown');
  if (node.revoked) return deny(input, 'denied_node_revoked');
  if (node.id !== input.node_id) return deny(input, 'denied_node_binding');
  const launch = await db.get<GovernedLaunchRow>(
    'SELECT * FROM governed_launch_authorizations WHERE team_id = ? AND id = ?',
    [teamId, input.launch_id],
  );
  if (!launch) return deny(input, 'denied_launch_unknown');
  if (launch.revoked_at !== null) return deny(input, 'denied_launch_revoked');
  if (launch.expires_at <= now) return deny(input, 'denied_launch_expired');
  if (launch.consumed_at === null) return deny(input, 'denied_launch_unknown');
  const member = await memberByName(db, teamId, input.member);
  if (
    launch.member_id !== member?.id ||
    launch.node_id !== input.node_id ||
    launch.correlation !== input.correlation ||
    launch.presence_id !== input.presence_id
  )
    return deny(input, 'denied_launch_mismatch');
  if (!member) return deny(input, 'denied_member_unknown');
  const status = resolveAccountStatus(member);
  if (
    member.kind !== 'agent' ||
    member.left_at !== null ||
    status === 'disabled' ||
    status === 'banned' ||
    status === 'archived'
  )
    return deny(input, 'denied_member_inactive');
  const binding = await db.get<{ node_id: string }>(
    'SELECT node_id FROM seat_nodes WHERE team_id = ? AND member_id = ? AND node_id = ?',
    [teamId, member.id, input.node_id],
  );
  if (!binding) return deny(input, 'denied_node_binding');
  const live = await db.get<{ id: string }>(
    `SELECT p.id FROM presence p JOIN members m ON m.id = p.member_id
       WHERE m.team_id = ? AND p.member_id = ? AND p.id = ?
         AND p.held_until IS NULL AND p.last_seen_at > ?`,
    [
      teamId,
      member.id,
      input.presence_id,
      now - (options.livePresenceMs ?? LIVE_PRESENCE_DEFAULT_MS),
    ],
  );
  if (!live) return deny(input, 'denied_presence_stale');
  const context = GovernedWorkContextSchema.parse(JSON.parse(launch.work_context));
  if (context.kind === 'lane') {
    const lane = await db.get<{ state: string; owner_seat: string | null }>(
      'SELECT state, owner_seat FROM lanes WHERE team_id = ? AND id = ?',
      [teamId, context.lane_id],
    );
    if (
      !lane ||
      lane.owner_seat !== member.name ||
      lane.state === 'done' ||
      lane.state === 'abandoned'
    )
      return deny(input, 'denied_context_lane');
  } else if (context.kind === 'act') {
    const act = await db.get<{ id: string }>(
      `SELECT m.id FROM messages m
         WHERE m.team_id = ? AND m.id = ? AND m.to_member = ?
           AND m.act NOT IN ('resolve', 'accept', 'decline')
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.team_id = m.team_id
               AND r.act IN ('accept','decline')
               AND r.in_reply_to = m.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.team_id = m.team_id
               AND r.act = 'resolve'
               AND r.thread_id = COALESCE(m.thread_id, m.id)
           )`,
      [teamId, context.act_id, member.id],
    );
    if (!act) return deny(input, 'denied_context_act');
  } else {
    return deny(input, 'denied_context_orientation');
  }
  const stored = await getGovernedPolicy(db, teamId);
  if (!stored) return deny(input, 'denied_policy');
  const models = stored.policy.members[member.name]?.models ?? stored.policy.team.models;
  if (!models.includes(input.model) || !input.model.startsWith(`${input.provider}/`))
    return deny(input, 'denied_model');
  return GovernedDecisionSchema.parse({
    decision: 'allow',
    reason: 'allowed',
    launch_id: input.launch_id,
    correlation: input.correlation,
    member: member.name,
    node_id: node.id,
    provider: input.provider,
    model: input.model,
  });
}
