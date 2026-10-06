import {
  type AgentKeyMint,
  type AskTier,
  acceptanceAskContract,
  POLICY_REVIEW_DEFAULT_MS,
  POLICY_REVIEW_MAX_MS,
  type Policy,
  type PolicyOverride,
  PolicyOverrideSchema,
  PolicySchema,
  TOKEN_PREFIXES,
  type WorkingHours,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { z } from 'zod';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendAuditRequired, appendReplicatedEvent } from './audit.js';
import { hashToken, newSecret } from './members.js';
import { resolveAccountStatus, type MemberRow, type TeamRow } from './rows.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/;
export const MIGRATED_BOOTSTRAP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type BootstrapCredentialUse = 'claim_seat' | 'claim_role' | 'host' | 'legacy';

export interface BootstrapCredential {
  id: string;
  team_id: string;
  key_hash: string;
  use_kind: BootstrapCredentialUse;
  target: string | null;
  label: string | null;
  state: 'active' | 'rotated' | 'revoked';
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  /** ADR 350: the Member proven by the `msac_` used to create this migration successor. */
  migration_target_member_id: string | null;
  /** ADR 350: first successful scoped claim/host authentication; minting alone is not readiness. */
  first_used_at: number | null;
}

export type BootstrapMigrationResult = {
  credential: BootstrapCredential;
  agent_key: string;
  predecessor_credential_id: string;
  replaced_credential_id: string | null;
};

export type BootstrapCutoverReadiness = {
  already_cut_over: boolean;
  unmet_seats: Array<{ member_id: string; name: string }>;
  unmet_hosts: string[];
};

export async function createTeam(
  db: Driver,
  input: {
    slug: string;
    display?: string | null;
    defaultLifecycle?: string;
    workingHours?: WorkingHours | null;
  },
): Promise<TeamRow> {
  if (!SLUG_RE.test(input.slug)) {
    throw new MusterdError(
      'bad_request',
      `invalid team slug "${input.slug}" (use [a-z0-9-], 1..32)`,
    );
  }
  const existing = await getTeamBySlug(db, input.slug);
  if (existing) {
    throw new MusterdError(
      'conflict',
      existing.archived_at
        ? `team "${input.slug}" already exists (archived) — its history keeps the slug`
        : `team "${input.slug}" already exists`,
    );
  }
  const now = Date.now();
  const row: TeamRow = {
    id: ulid(),
    slug: input.slug,
    display: input.display ?? null,
    default_lifecycle: input.defaultLifecycle ?? 'forever',
    archived_at: null,
    agent_key_hash: null,
    bootstrap_cutover_at: null,
    policy: null,
    working_hours: input.workingHours ? JSON.stringify(input.workingHours) : null,
    created_at: now,
    updated_at: now,
  };
  await db.run(
    `INSERT INTO teams (id, slug, display, default_lifecycle, archived_at, working_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.display,
      row.default_lifecycle,
      row.archived_at,
      row.working_hours,
      row.created_at,
      row.updated_at,
    ],
  );
  return row;
}

export async function getTeamBySlug(db: Driver, slug: string): Promise<TeamRow | undefined> {
  return await db.get<TeamRow>('SELECT * FROM teams WHERE slug = ?', [slug]);
}

export async function getTeamById(db: Driver, id: string): Promise<TeamRow | undefined> {
  return await db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [id]);
}

/**
 * Every non-archived team, for the daemon's own periodic passes (ADR 229's sweep). Archived teams are
 * excluded on the same principle as `requireTeam`: a soft-archived team drops off every surface at
 * once, and a background job acting on one would be the exception that makes that untrue.
 */
export async function listActiveTeams(db: Driver): Promise<{ id: string; slug: string }[]> {
  return await db.all<{ id: string; slug: string }>(
    'SELECT id, slug FROM teams WHERE archived_at IS NULL',
  );
}

/**
 * Like getTeamBySlug but throws not_found. An archived team is invisible here too: every team-scoped
 * route (auth, roster, status, ws join, claim) resolves through this, so soft-archiving a team makes
 * it drop off every surface at once while its rows (history, audit, provenance) survive in the db.
 */
export async function requireTeam(db: Driver, slug: string): Promise<TeamRow> {
  const t = await getTeamBySlug(db, slug);
  if (!t) throw new MusterdError('not_found', `no team "${slug}"`);
  if (t.archived_at) throw new MusterdError('not_found', `team "${slug}" is archived`);
  return t;
}

/* ── v0.3 P3 team secrets + policy (ADR 076) ─────────────────────────────────────────────────────
 * Team-scoped secrets live on the team row (agent key is one-per-team, rotatable); only the sha256
 * hash is stored (SPEC A.2). Plaintext is returned once at mint and never persisted/logged. */

/**
 * Rotate (or set) the team agent key: mint a fresh `mskey_` secret, store its hash, return the
 * plaintext **once**. Any prior key is invalidated by the overwrite.
 */
export async function rotateAgentKey(db: Driver, teamId: string): Promise<AgentKeyMint> {
  const team = await db.get<{ bootstrap_cutover_at: number | null }>(
    'SELECT bootstrap_cutover_at FROM teams WHERE id = ?',
    [teamId],
  );
  if (!team) throw new MusterdError('not_found', 'Team not found');
  if (team.bootstrap_cutover_at !== null) {
    throw new MusterdError('conflict', 'legacy bootstrap authority is already cut over');
  }
  const agentKey = newSecret(TOKEN_PREFIXES.agent_key);
  const now = Date.now();
  const keyHash = hashToken(agentKey);
  await db.tx(async (t) => {
    await t.run(
      `UPDATE agent_bootstrap_credentials
       SET state = 'revoked', revoked_at = ?
       WHERE team_id = ? AND use_kind = 'legacy' AND state IN ('active', 'rotated')`,
      [now, teamId],
    );
    await t.run('UPDATE teams SET agent_key_hash = ?, updated_at = ? WHERE id = ?', [
      keyHash,
      now,
      teamId,
    ]);
    await t.run(
      `INSERT INTO agent_bootstrap_credentials
        (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by,
         created_at, rotated_at, revoked_at, migration_target_member_id, first_used_at)
       VALUES (?, ?, ?, 'legacy', NULL, 'team-key-compatibility', 'active', NULL, NULL,
               ?, NULL, NULL, NULL, NULL)`,
      [ulid(), teamId, keyHash, now],
    );
  });
  return { agent_key: agentKey };
}

/** The team's agent-key hash, or null if none is set. */
export async function getAgentKeyHash(db: Driver, teamId: string): Promise<string | null> {
  const row = await db.get<{ agent_key_hash: string | null }>(
    'SELECT agent_key_hash FROM teams WHERE id = ?',
    [teamId],
  );
  return row?.agent_key_hash ?? null;
}

/**
 * Mint a bootstrap credential constrained by a server-held purpose and target (ADR 344).
 * The caller receives the plaintext once; only its hash is retained.
 */
export async function mintBootstrapCredential(
  db: Driver,
  input: {
    teamId: string;
    useKind: Exclude<BootstrapCredentialUse, 'legacy'>;
    target: string;
    label?: string;
    expiresAt?: number;
    createdBy?: string;
  },
): Promise<{ credential: BootstrapCredential; agent_key: string; rotated: string[] }> {
  const agent_key = newSecret(TOKEN_PREFIXES.agent_key);
  const now = Date.now();
  const credential: BootstrapCredential = {
    id: ulid(),
    team_id: input.teamId,
    key_hash: hashToken(agent_key),
    use_kind: input.useKind,
    target: input.target,
    label: input.label ?? null,
    state: 'active',
    expires_at: input.expiresAt ?? null,
    created_by: input.createdBy ?? null,
    created_at: now,
    rotated_at: null,
    revoked_at: null,
    migration_target_member_id: null,
    first_used_at: null,
  };
  const rotated = await db.tx(async (t) => {
    const predecessors = (
      await t.all<{ id: string }>(
        `SELECT id FROM agent_bootstrap_credentials
         WHERE team_id = ? AND use_kind = ? AND target = ? AND state = 'active'`,
        [input.teamId, input.useKind, input.target],
      )
    ).map((row) => row.id);
    // A same-scope mint is the explicit start of a staged rotation. The predecessor remains valid
    // until the admin revokes it, but inventory names the overlap rather than showing two unrelated
    // active records (ADR 344 §5–6).
    await t.run(
      `UPDATE agent_bootstrap_credentials
       SET state = 'rotated', rotated_at = ?
       WHERE team_id = ? AND use_kind = ? AND target = ? AND state = 'active'`,
      [now, input.teamId, input.useKind, input.target],
    );
    await t.run(
      `INSERT INTO agent_bootstrap_credentials
        (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by, created_at, rotated_at, revoked_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credential.id,
        credential.team_id,
        credential.key_hash,
        credential.use_kind,
        credential.target,
        credential.label,
        credential.state,
        credential.expires_at,
        credential.created_by,
        credential.created_at,
        credential.rotated_at,
        credential.revoked_at,
      ],
    );
    return predecessors;
  });
  return { credential, agent_key, rotated };
}

/** Resolve an active, unexpired scoped bootstrap credential by its presented secret. */
export async function findBootstrapCredential(
  db: Driver,
  teamId: string,
  agentKey: string,
): Promise<BootstrapCredential | null> {
  return (
    (await db.get<BootstrapCredential>(
      `SELECT * FROM agent_bootstrap_credentials
         WHERE team_id = ? AND key_hash = ? AND state IN ('active', 'rotated')
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      [teamId, hashToken(agentKey), Date.now()],
    )) ?? null
  );
}

/** Resolve a credential record regardless of lifecycle state, for redacted refusal audit only. */
export async function findBootstrapCredentialRecord(
  db: Driver,
  teamId: string,
  agentKey: string,
): Promise<BootstrapCredential | null> {
  return (
    (await db.get<BootstrapCredential>(
      `SELECT * FROM agent_bootstrap_credentials
         WHERE team_id = ? AND key_hash = ?
         LIMIT 1`,
      [teamId, hashToken(agentKey)],
    )) ?? null
  );
}

/** Revoke one scoped bootstrap credential. Legacy team keys remain on their compatibility path. */
export async function revokeBootstrapCredential(
  db: Driver,
  teamId: string,
  credentialId: string,
): Promise<boolean> {
  const result = await db.run(
    `UPDATE agent_bootstrap_credentials
       SET state = 'revoked', revoked_at = ?
       WHERE id = ? AND team_id = ? AND state IN ('active', 'rotated') AND use_kind <> 'legacy'`,
    [Date.now(), credentialId, teamId],
  );
  return result.changes === 1;
}

/** Admin inventory source. Callers must redact key_hash before crossing a transport boundary. */
export async function listBootstrapCredentials(
  db: Driver,
  teamId: string,
): Promise<BootstrapCredential[]> {
  return await db.all<BootstrapCredential>(
    `SELECT * FROM agent_bootstrap_credentials
       WHERE team_id = ?
       ORDER BY created_at DESC, id DESC`,
    [teamId],
  );
}

/**
 * Exchange legacy Team-wide bootstrap authority for a successor restricted to the agent seat proven
 * by its independent `msac_`. Team and Member are derived from stored credential hashes; callers do
 * not declare either identity (ADR 350).
 */
export async function migrateLegacyBootstrapCredential(
  db: Driver,
  input: { legacyKey: string; seatCredential: string; now?: number },
): Promise<BootstrapMigrationResult> {
  return db.tx(async (t) => {
    const now = input.now ?? Date.now();
    const legacy = await t.get<BootstrapCredential>(
      `SELECT * FROM agent_bootstrap_credentials
         WHERE key_hash = ? AND use_kind = 'legacy' AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      [hashToken(input.legacyKey), now],
    );
    if (!legacy) {
      throw new MusterdError('unauthorized', 'invalid or inactive legacy bootstrap credential');
    }

    const team = await t.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [legacy.team_id]);
    if (!team || team.archived_at !== null) {
      throw new MusterdError(
        'forbidden',
        'legacy bootstrap credential belongs to an archived Team',
      );
    }

    const member = await t.get<MemberRow>(
      `SELECT * FROM members
         WHERE credential_hash = ? AND kind = 'agent' AND observer = 0 AND left_at IS NULL
         LIMIT 1`,
      [hashToken(input.seatCredential)],
    );
    if (!member) {
      throw new MusterdError('unauthorized', 'invalid or inactive agent seat credential');
    }
    if (member.team_id !== legacy.team_id) {
      throw new MusterdError(
        'forbidden',
        'legacy bootstrap and agent seat credential must identify the same Team',
      );
    }
    const accountStatus = resolveAccountStatus(member);
    if (
      accountStatus === 'disabled' ||
      accountStatus === 'banned' ||
      accountStatus === 'archived'
    ) {
      throw new MusterdError('forbidden', `seat "${member.name}" is ${accountStatus}`);
    }

    const usedSuccessor = await t.get<{ id: string }>(
      `SELECT id FROM agent_bootstrap_credentials
         WHERE team_id = ? AND migration_target_member_id = ? AND first_used_at IS NOT NULL
         ORDER BY first_used_at DESC, id DESC
         LIMIT 1`,
      [legacy.team_id, member.id],
    );
    if (usedSuccessor) {
      throw new MusterdError(
        'conflict',
        `seat "${member.name}" already migrated to a scoped bootstrap credential`,
      );
    }

    const unused = await t.get<{ id: string }>(
      `SELECT id FROM agent_bootstrap_credentials
         WHERE team_id = ? AND migration_target_member_id = ?
           AND state = 'active' AND first_used_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      [legacy.team_id, member.id],
    );
    if (unused) {
      await t.run(
        `UPDATE agent_bootstrap_credentials
         SET state = 'revoked', revoked_at = ?
         WHERE id = ? AND state = 'active' AND first_used_at IS NULL`,
        [now, unused.id],
      );
    }

    const agent_key = newSecret(TOKEN_PREFIXES.agent_key);
    const credential: BootstrapCredential = {
      id: ulid(),
      team_id: legacy.team_id,
      key_hash: hashToken(agent_key),
      use_kind: 'claim_seat',
      target: member.name,
      label: 'legacy-migration',
      state: 'active',
      expires_at: now + MIGRATED_BOOTSTRAP_TTL_MS,
      created_by: member.name,
      created_at: now,
      rotated_at: null,
      revoked_at: null,
      migration_target_member_id: member.id,
      first_used_at: null,
    };
    await t.run(
      `INSERT INTO agent_bootstrap_credentials
        (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by,
         created_at, rotated_at, revoked_at, migration_target_member_id, first_used_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?)`,
      [
        credential.id,
        credential.team_id,
        credential.key_hash,
        credential.use_kind,
        credential.target,
        credential.label,
        credential.state,
        credential.expires_at,
        credential.created_by,
        credential.created_at,
        credential.rotated_at,
        credential.revoked_at,
        credential.migration_target_member_id,
        credential.first_used_at,
      ],
    );

    return {
      credential,
      agent_key,
      predecessor_credential_id: legacy.id,
      replaced_credential_id: unused?.id ?? null,
    };
  });
}

/** Record adoption evidence once; legacy compatibility authentication never satisfies readiness. */
export async function recordBootstrapCredentialUse(
  db: Driver,
  credentialId: string,
  now = Date.now(),
): Promise<void> {
  await db.run(
    `UPDATE agent_bootstrap_credentials
     SET first_used_at = COALESCE(first_used_at, ?)
     WHERE id = ? AND use_kind <> 'legacy'`,
    [now, credentialId],
  );
}

/** Derive legacy-key cutover readiness only from durable Team state and observed scoped use. */
export async function bootstrapCutoverReadiness(
  db: Driver,
  teamId: string,
  now = Date.now(),
): Promise<BootstrapCutoverReadiness> {
  const team = await db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
  if (!team) throw new MusterdError('not_found', 'Team not found');

  const unmet_seats = await db.all<{ member_id: string; name: string }>(
    `SELECT m.id AS member_id, m.name
       FROM members m
       WHERE m.team_id = ?
         AND m.kind = 'agent'
         AND m.observer = 0
         AND m.bound_at IS NOT NULL
         AND m.left_at IS NULL
         AND (m.account_status IS NULL OR m.account_status NOT IN ('disabled', 'banned', 'archived'))
         AND NOT EXISTS (
           SELECT 1
           FROM agent_bootstrap_credentials c
           WHERE c.team_id = m.team_id
             AND c.use_kind = 'claim_seat'
             AND c.target = m.name
             AND c.state = 'active'
             AND (c.expires_at IS NULL OR c.expires_at > ?)
             AND c.first_used_at IS NOT NULL
         )
       ORDER BY m.name, m.id`,
    [teamId, now],
  );

  const unmet_hosts = (
    await db.all<{ host: string }>(
      `SELECT DISTINCT r.host
       FROM residency r
       JOIN members m ON m.id = r.member_id
       WHERE r.team_id = ?
         AND m.left_at IS NULL
         AND (m.account_status IS NULL OR m.account_status NOT IN ('disabled', 'banned', 'archived'))
         AND NOT EXISTS (
           SELECT 1
           FROM agent_bootstrap_credentials c
           WHERE c.team_id = r.team_id
             AND c.use_kind = 'host'
             AND c.target = r.host
             AND c.state = 'active'
             AND (c.expires_at IS NULL OR c.expires_at > ?)
             AND c.first_used_at IS NOT NULL
         )
       ORDER BY r.host`,
      [teamId, now],
    )
  ).map((row) => row.host);

  return {
    already_cut_over: team.bootstrap_cutover_at !== null,
    unmet_seats,
    unmet_hosts,
  };
}

/** Transactionally disable one Team's legacy bootstrap authority after its scoped targets are ready. */
export async function cutoverLegacyBootstrap(
  db: Driver,
  input: { teamId: string; actor: string; force: boolean; now?: number },
): Promise<BootstrapCutoverReadiness> {
  return db.tx(async (t) => {
    const now = input.now ?? Date.now();
    const readiness = await bootstrapCutoverReadiness(t, input.teamId, now);
    if (readiness.already_cut_over) return readiness;
    if (!input.force && (readiness.unmet_seats.length > 0 || readiness.unmet_hosts.length > 0)) {
      throw new MusterdError('conflict', 'legacy bootstrap cutover is not ready');
    }

    await t.run(
      `UPDATE agent_bootstrap_credentials
       SET state = 'revoked', revoked_at = ?
       WHERE team_id = ? AND use_kind = 'legacy' AND state IN ('active', 'rotated')`,
      [now, input.teamId],
    );
    await t.run(
      `UPDATE teams
       SET agent_key_hash = NULL, bootstrap_cutover_at = ?, updated_at = ?
       WHERE id = ?`,
      [now, now, input.teamId],
    );
    await appendAuditRequired(t, input.teamId, {
      actor: input.actor,
      action: 'bootstrap_credential.cutover',
      target: input.teamId,
      result: 'allow',
      detail: {
        force: input.force,
        unmet_member_ids: readiness.unmet_seats.map((seat) => seat.member_id),
        unmet_hosts: readiness.unmet_hosts,
      },
    });
    return readiness;
  });
}

/**
 * Set the team governance policy (ADR 185). Stores **only what was chosen** — the sparse doc goes to
 * the row verbatim, and defaults are applied on read by `getPolicy`, never here. Replace semantics,
 * not patch: a key the new doc omits is unset, which is how `--ask-slack-webhook off` and
 * `--reset-policy` restore a real default instead of storing one. Returns the effective policy.
 *
 * The old shape parsed before storing, so the first write of any single knob materialized every
 * default into the row and the schema default was dead for that team from then on — see ADR 185 and
 * the #530 recalibration that had to ship a data change on top of a code change.
 */
export async function setPolicy(
  db: Driver,
  teamId: string,
  policy: z.input<typeof PolicyOverrideSchema>,
): Promise<Policy> {
  const stored = PolicyOverrideSchema.parse(policy);
  await db.run('UPDATE teams SET policy = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(stored),
    Date.now(),
    teamId,
  ]);
  return await getPolicy(db, teamId);
}

/**
 * Set the policy AND stamp the change for replication (residence-2 census gap 1, 2026-09-03).
 *
 * The write and its `policy.change` event are one unit, the way every lane transition is: the row
 * this daemon holds and the fact its peers will fold are the same fact, or neither happened. The
 * stamped `detail` is the STORED sparse doc — the same thing `setPolicy` put in the row, so a peer
 * that folds it stores exactly what the admin chose and keeps its own defaults alive for the rest
 * (ADR 185).
 *
 * Only the HUB calls this. Policy is hub-authoritative (ADR 325 residence 1): a joiner forwards to
 * the hub and learns the answer back through the fold, so no second origin ever mints the verb.
 */
export async function applyPolicyChange(
  db: Driver,
  teamId: string,
  actor: string,
  policy: z.input<typeof PolicyOverrideSchema>,
  opts: { enforce?: boolean } = {},
): Promise<{ policy: Policy; stored: PolicyOverride }> {
  return db.tx(async (t) => {
    const stored = stampReviewBy(PolicyOverrideSchema.parse(policy), Date.now());
    if (opts.enforce !== false) {
      const refusal = await policyPairRefusal(t, teamId, PolicySchema.parse(stored));
      if (refusal) throw refusal;
    }
    const effective = await setPolicy(t, teamId, stored);
    await appendReplicatedEvent(t, teamId, {
      actor,
      action: 'policy.change',
      target: null,
      result: 'allow',
      detail: stored,
    });
    return { policy: effective, stored };
  });
}

/**
 * ADR 533: every stored doc that holds a knob carries the date its admins are asked to look again.
 * A write that names none gets the default window from now; one past `POLICY_REVIEW_MAX_MS` out, or
 * already behind us, is refused — a review date in the past would raise its ask on the next sweep,
 * which is never what a write meant. An empty doc (`{}`) carries none: defaults need no review, and
 * dropping every knob is exactly how a review ends with "drop".
 */
export function stampReviewBy(stored: PolicyOverride, now: number): PolicyOverride {
  const { review_by, ...knobs } = stored;
  if (Object.keys(knobs).length === 0) return knobs;
  if (review_by === undefined) return { ...knobs, review_by: now + POLICY_REVIEW_DEFAULT_MS };
  if (review_by <= now) throw new MusterdError('validation', 'review_by must be in the future');
  if (review_by > now + POLICY_REVIEW_MAX_MS)
    throw new MusterdError('validation', 'review_by may be at most 365 days out');
  return stored;
}

/**
 * ADR 463 §4.1: one live sponsored agent enrolled in residency, if any — the fact that makes
 * `agent_connect: 'any_member'` unsafe on this team. Null when no sponsored agent is hosted.
 */
async function anyHostedSponsoredAgent(
  db: Driver,
  teamId: string,
): Promise<{ agent: string; host: string } | null> {
  return (
    (await db.get<{ agent: string; host: string }>(
      `SELECT m.name AS agent, r.host AS host FROM residency r JOIN members m ON m.id = r.member_id
          WHERE r.team_id = ? AND m.sponsored_by IS NOT NULL AND m.left_at IS NULL
          ORDER BY m.name LIMIT 1`,
      [teamId],
    )) ?? null
  );
}

/**
 * ADR 463 §4.3 / §4.1: `agent_connect: 'any_member'` lets any human issue a takeover link, so it is
 * accepted only with `invite_requires_expiry` (every invited member expires) and only while no
 * sponsored agent is hosted (a hosted agent runs on its sponsor's machine and must not be
 * connectable). Checked on the hub's write path; a fold or restatement never refuses.
 */
async function policyPairRefusal(
  db: Driver,
  teamId: string,
  effective: Policy,
): Promise<MusterdError | null> {
  if (effective.agent_connect !== 'any_member') return null;
  if (!effective.invite_requires_expiry)
    return new MusterdError(
      'validation',
      "agent_connect 'any_member' requires invite_requires_expiry: true — set both in one write (ADR 463 §4.3)",
    );
  const hosted = await anyHostedSponsoredAgent(db, teamId);
  if (hosted)
    return new MusterdError(
      'conflict',
      `agent_connect 'any_member' is refused while a sponsored agent is hosted ("${hosted.agent}" on ${hosted.host}) — ADR 463 §4.1`,
    );
  return null;
}

/**
 * Restate the current stored policy as one stamped `policy.change` when the hub has never
 * stamped one (ADR 398).
 *
 * ADR 367 stamps new writes. A policy stored before the kind existed, or via silent `setPolicy`,
 * has `origin_seq = 0` (or no audit row at all) and never ships. A joiner then runs different
 * `loops` / `hourly_cap` than the hub — the live hole that made every cloud-seat wake a 5-minute
 * reply doorbell. This is the one-shot catch-up: if a stamped `policy.change` already exists, we
 * do nothing, so a later silent `setPolicy` stays the projector's seam (census.test.ts gap 1).
 *
 * Returns whether a stamp was minted.
 */
export async function restateUnstampedPolicy(db: Driver, teamId: string): Promise<boolean> {
  const stamped = await db.get<{ one: number }>(
    `SELECT 1 AS one FROM audit
        WHERE team_id = ? AND action = 'policy.change' AND origin_seq > 0
        LIMIT 1`,
    [teamId],
  );
  if (stamped) return false;
  const stored = await getStoredPolicy(db, teamId);
  if (Object.keys(stored).length === 0) return false;
  // A restatement repeats what the hub already holds — never refuse it (ADR 463 §4.3's pair rule
  // guards new choices, and a team stored before the rule existed must still converge).
  await applyPolicyChange(db, teamId, await policyRestateActor(db, teamId), stored, {
    enforce: false,
  });
  return true;
}

/** Who set the unstamped row, else the team's oldest living member, else a hub fallback. */
async function policyRestateActor(db: Driver, teamId: string): Promise<string> {
  const unstamped = await db.get<{ actor: string | null }>(
    `SELECT actor FROM audit
        WHERE team_id = ? AND action = 'policy.change' AND origin_seq = 0 AND actor IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
    [teamId],
  );
  if (unstamped?.actor) return unstamped.actor;
  const oldest = await db.get<{ name: string }>(
    `SELECT name FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at ASC LIMIT 1`,
    [teamId],
  );
  return oldest?.name ?? 'hub';
}

async function readStored(db: Driver, teamId: string): Promise<unknown> {
  const row = await db.get<{ policy: string | null }>('SELECT policy FROM teams WHERE id = ?', [
    teamId,
  ]);
  return row?.policy ? JSON.parse(row.policy) : {};
}

/** The team policy, parsed with defaults applied (an unset policy ⇒ all defaults). */
export async function getPolicy(db: Driver, teamId: string): Promise<Policy> {
  return PolicySchema.parse(await readStored(db, teamId));
}

/**
 * The wait a `lane_review` ask at `tier` promises on this team (ADR 506): the tier's own timeout,
 * floored at the team's `acceptance_review_window_ms`. Every ready row and reroute records this.
 */
export async function acceptanceTimeoutMs(
  db: Driver,
  teamId: string,
  tier: AskTier,
): Promise<number> {
  const { acceptance_review_window_ms } = await getPolicy(db, teamId);
  return acceptanceAskContract(tier, acceptance_review_window_ms).timeout_ms;
}

/**
 * The team policy **as stored** — sparse, only the keys somebody chose (ADR 185). The write path and
 * the explicit-vs-inherited display read this; every consumer of effective values wants `getPolicy`.
 */
export async function getStoredPolicy(db: Driver, teamId: string): Promise<PolicyOverride> {
  return PolicyOverrideSchema.parse(await readStored(db, teamId));
}

/** Update a team's durable fields in place (ADR 058 reconcile upsert). Preserves id + created_at. */
export async function updateTeam(
  db: Driver,
  id: string,
  fields: {
    display: string | null;
    defaultLifecycle: string;
    workingHours?: WorkingHours | null;
  },
): Promise<void> {
  await db.run(
    'UPDATE teams SET display = ?, default_lifecycle = ?, working_hours = ?, updated_at = ? WHERE id = ?',
    [
      fields.display,
      fields.defaultLifecycle,
      fields.workingHours ? JSON.stringify(fields.workingHours) : null,
      Date.now(),
      id,
    ],
  );
}

/**
 * Soft-archive a team (the inverse of `team create`): sets `archived_at`, which requireTeam treats as
 * gone — the team drops off status/rosters and refuses auth, but every row is kept. Resolves the slug
 * directly (not via requireTeam) so the error for an already-archived team names the real state.
 */
export async function archiveTeam(db: Driver, slug: string): Promise<{ archived_at: number }> {
  const t = await getTeamBySlug(db, slug);
  if (!t) throw new MusterdError('not_found', `no team "${slug}"`);
  if (t.archived_at) {
    throw new MusterdError('conflict', `team "${slug}" is already archived`);
  }
  const now = Date.now();
  await db.run('UPDATE teams SET archived_at = ?, updated_at = ? WHERE id = ?', [now, now, t.id]);
  return { archived_at: now };
}
