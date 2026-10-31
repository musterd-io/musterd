import {
  effectiveCapabilities,
  type Lifecycle,
  mergeRoleDefaults,
  seatRoles,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { log } from '../log.js';
import { DAEMON_SERVICE_SEATS } from '../store/boardSeat.js';
import {
  addMember,
  getMemberById,
  getMemberByName,
  leaveMember,
  listMembers,
  type MemberIdentityFields,
  reviveMember,
  setMemberGovernance,
  setMemberSponsor,
  updateMemberIdentity,
} from '../store/members.js';
import { deleteRoles, listRoleNames, roleDefaultsMap, upsertRole } from '../store/roles.js';
import { type MemberRow, resolveCapabilities, type TeamRow } from '../store/rows.js';
import { revokeSponsoredDescendants } from '../store/sponsoredCascade.js';
import { createTeam, getTeamBySlug, updateTeam } from '../store/teams.js';
import { joinerEnrollment } from '../sync/claim.js';
import { type LoadedSeat, loadTeamSpec, type TeamSpec } from './load.js';

/**
 * Reconcile the durable files into the db projection (ADR 058 / projection-reconcile.md). This is a
 * **match-by-name delta**, never a truncate-and-reload: `id` and `token_hash` are daemon-private
 * anchors that must survive a reconcile (the message log and live tokens depend on them). The loop is
 * declarative and idempotent — re-running it converges to the same state, which is what makes the
 * flaky `fs.watch` trigger safe.
 */

export interface ReconcileResult {
  slug: string;
  added: string[];
  updated: string[];
  revived: string[];
  removed: string[];
  /** Tokens minted this pass (ADD + REVIVE), keyed by seat name — surfaced for project-and-return. */
  minted: Record<string, string>;
  /** Fail-closed parse errors carried from the spec (skipped seats). */
  errors: string[];
  /** Keys dropped because no schema knows them — the entry projected, minus those fields. */
  warnings: string[];
  /** Roster files whose bytes are not canonical (ADR 058 guard 2) — projected anyway. */
  drift: string[];
}

function resolveLifecycle(
  seat: LoadedSeat['seat'],
  teamLifecycle: Lifecycle,
): { lifecycle: Lifecycle; lifecycleUntil: number | null } {
  const lifecycle = (seat.lifecycle ?? teamLifecycle) as Lifecycle;
  const lifecycleUntil = lifecycle === 'until' && seat.until ? Date.parse(seat.until) : null;
  return { lifecycle, lifecycleUntil };
}

/** ADR 700: the admin statuses that take a member's standing (a halt, ADR 501, is a pause, not a loss). */
const STANDING_LOST = new Set(['disabled', 'banned', 'archived']);

/** ADR 700 decision 3: whether a member row stands as a sponsor now. */
function rowStands(m: MemberRow, now: number): boolean {
  if (m.left_at !== null) return false;
  if (m.account_status !== null && STANDING_LOST.has(m.account_status)) return false;
  return !(m.lifecycle === 'until' && m.lifecycle_until !== null && m.lifecycle_until < now);
}

/**
 * ADR 700 decision 2: does this daemon hold the hub's own record that `sponsor` minted `agent`? At
 * the hub that is its own row. At a joiner it is a row folded from another node: the hub's ingest
 * refuses a pushed copy, so a folded row is the hub's by construction, and a joiner's own mint
 * never vouches.
 */
async function sponsorshipVouched(
  db: Driver,
  team: TeamRow,
  agent: string,
  sponsor: string,
): Promise<boolean> {
  const joiner = await joinerEnrollment(db, team.id, team.slug);
  const row = await db.get<{ id: string }>(
    `SELECT id FROM audit WHERE team_id = ? AND action = 'member.sponsored_agent_created'
       AND actor = ? AND target = ?${joiner ? ' AND origin_node IS NOT NULL AND origin_node <> ?' : ''}
     LIMIT 1`,
    joiner ? [team.id, sponsor, agent, joiner.node_id] : [team.id, sponsor, agent],
  );
  return row !== undefined;
}

/** Reconcile one team spec into the db. Returns the delta applied + any tokens minted. */
export async function reconcileTeam(db: Driver, spec: TeamSpec): Promise<ReconcileResult> {
  const teamLifecycle = spec.team.lifecycle as Lifecycle;
  // Upsert the team identity (durable fields only; id + created_at preserved).
  let team = await getTeamBySlug(db, spec.team.slug);
  if (!team) {
    team = await createTeam(db, {
      slug: spec.team.slug,
      display: spec.team.display ?? null,
      defaultLifecycle: teamLifecycle,
      workingHours: spec.team.working_hours ?? null,
    });
  } else {
    await updateTeam(db, team.id, {
      display: spec.team.display ?? null,
      defaultLifecycle: teamLifecycle,
      workingHours: spec.team.working_hours ?? null,
    });
  }

  // Project role defaults (ADR 070): upsert the roles present in the files, drop the ones absent.
  const desiredRoles = new Set(spec.roles.map((r) => r.name));
  for (const { name, role } of spec.roles) {
    await upsertRole(
      db,
      team.id,
      name,
      role.capabilities ?? {},
      role.charter ?? null,
      role.summary ?? null,
      role.skill ?? null,
    );
  }
  await deleteRoles(
    db,
    team.id,
    (await listRoleNames(db, team.id)).filter((n) => !desiredRoles.has(n)),
  );
  const roleDefaults = await roleDefaultsMap(db, team.id);

  const result: ReconcileResult = {
    slug: spec.team.slug,
    added: [],
    updated: [],
    revived: [],
    removed: [],
    minted: {},
    errors: [...spec.errors],
    warnings: [...spec.warnings],
    drift: [...spec.drift],
  };
  const desired = new Set(spec.seats.map((s) => s.name));
  const now = Date.now();
  const seatOf = new Map(spec.seats.map((s) => [s.name, s.seat]));

  // ADR 700 decision 2: who sponsors each seat this pass. A sponsorship the db already holds was
  // vouched for, and stands whatever the file says — clearing it would widen `hostMayServe` from the
  // sponsor's own key to every team-wide one. A file's line counts only where the hub's mint fact
  // vouches for it; otherwise the agent projects unsponsored, so a forged line grants nothing.
  const sponsorOf = new Map<string, string>();
  const newlyVouched = new Set<string>();
  for (const { name, seat } of spec.seats) {
    const existing = await getMemberByName(db, team.id, name);
    const held = existing?.sponsored_by
      ? (await getMemberById(db, existing.sponsored_by))?.name
      : undefined;
    if (held !== undefined) {
      sponsorOf.set(name, held);
      if (seat.sponsored_by === undefined) {
        result.warnings.push(
          `seat "${name}" omits sponsored_by — its vouched sponsor ${held} stands; only removing the ` +
            'agent or the sponsor losing standing ends it (ADR 700)',
        );
      } else if (seat.sponsored_by !== held) {
        result.warnings.push(
          `seat "${name}" names sponsor "${seat.sponsored_by}", but its vouched sponsor is ${held} — kept (ADR 700)`,
        );
      }
    } else if (seat.sponsored_by !== undefined) {
      if (await sponsorshipVouched(db, team, name, seat.sponsored_by)) {
        sponsorOf.set(name, seat.sponsored_by);
        newlyVouched.add(name);
      } else {
        result.warnings.push(
          `seat "${name}" names sponsor "${seat.sponsored_by}" with no mint of theirs on record here — ` +
            'projected unsponsored (ADR 700)',
        );
      }
    }
  }

  // ADR 700 decision 3: whether a sponsor stands AFTER this pass — its file decides (removed, an
  // admin status, a lapsed `until`); a sponsor with no file keeps its db row's word.
  const standsAfter = async (sponsor: string): Promise<boolean> => {
    const seat = seatOf.get(sponsor);
    if (!seat) {
      const row = await getMemberByName(db, team!.id, sponsor);
      return row !== undefined && desired.has(sponsor) && rowStands(row, now);
    }
    if (seat.account_status !== undefined && STANDING_LOST.has(seat.account_status)) return false;
    const { lifecycleUntil } = resolveLifecycle(seat, teamLifecycle);
    return lifecycleUntil === null || lifecycleUntil >= now;
  };
  const chainStands = async (name: string): Promise<boolean> => {
    const seen = new Set<string>([name]);
    for (let s = sponsorOf.get(name); s !== undefined; s = sponsorOf.get(s)) {
      if (seen.has(s)) break;
      seen.add(s);
      if (!(await standsAfter(s))) return false;
    }
    return true;
  };
  // A sponsor's standing as the db holds it before this pass, for each live sponsor — what the
  // cascade below compares against.
  const sponsorsBefore: MemberRow[] = [];
  const live = await listMembers(db, team.id);
  for (const m of live) {
    if (live.some((c) => c.sponsored_by === m.id) && rowStands(m, now)) sponsorsBefore.push(m);
  }

  for (const { name, seat } of spec.seats) {
    let { lifecycle, lifecycleUntil } = resolveLifecycle(seat, teamLifecycle);
    // ADR 449 §2, held on a seat-file team (ADR 700 decision 3): an agent never outlives its sponsor.
    const sponsor = sponsorOf.get(name);
    if (sponsor !== undefined) {
      const sponsorSeat = seatOf.get(sponsor);
      const sponsorRow = sponsorSeat ? undefined : await getMemberByName(db, team.id, sponsor);
      const sponsorUntil = sponsorSeat
        ? resolveLifecycle(sponsorSeat, teamLifecycle).lifecycleUntil
        : sponsorRow?.lifecycle === 'until'
          ? sponsorRow.lifecycle_until
          : null;
      if (sponsorUntil !== null && (lifecycleUntil === null || lifecycleUntil > sponsorUntil)) {
        lifecycle = 'until';
        lifecycleUntil = sponsorUntil;
      }
    }
    const fields: MemberIdentityFields = {
      kind: seat.kind,
      role: seat.role ?? '',
      lifecycle,
      lifecycleUntil,
      workingHours: seat.working_hours ?? null,
      slackUserId: seat.slack_user_id ?? null,
      // ADR 374: the file owns the hue. Absent in the file is a statement — null — not a gap for
      // the daemon to fill; otherwise two machines reconciling the same roster would disagree.
      hue: seat.hue ?? null,
    };
    const existing = await getMemberByName(db, team.id, name); // includes tombstoned rows
    if (!existing) {
      // ADD — the only path (besides REVIVE) that originates a secret.
      const { token } = await addMember(db, team, {
        name,
        kind: fields.kind,
        role: fields.role,
        lifecycle: fields.lifecycle,
        lifecycleUntil: fields.lifecycleUntil,
        workingHours: fields.workingHours ?? null,
        slackUserId: fields.slackUserId ?? null,
        hue: fields.hue ?? null,
        // The file's word: stored, never refused (lane 01M2P43WQ7). A throw here would abort the
        // whole team's reconcile over one seat file's colour.
        hueDeclared: true,
      });
      result.added.push(name);
      result.minted[name] = token;
    } else if (existing.left_at !== null) {
      // REVIVE — same id (log continuity), re-minted token (deletion was a revocation), back to declared.
      const token = await reviveMember(db, existing.id, fields);
      result.revived.push(name);
      result.minted[name] = token;
    } else if (
      existing.kind !== fields.kind ||
      existing.role !== fields.role ||
      existing.lifecycle !== fields.lifecycle ||
      existing.lifecycle_until !== fields.lifecycleUntil ||
      existing.working_hours !==
        (fields.workingHours ? JSON.stringify(fields.workingHours) : null) ||
      existing.slack_user_id !== fields.slackUserId ||
      existing.hue !== (fields.hue ?? null)
    ) {
      // UPDATE in place — id, token_hash, bound_at preserved (live session unaffected).
      await updateMemberIdentity(db, existing.id, fields);
      result.updated.push(name);
    }
  }

  for (const name of newlyVouched) {
    const agent = await getMemberByName(db, team.id, name);
    const sponsor = await getMemberByName(db, team.id, sponsorOf.get(name)!);
    if (agent && sponsor) await setMemberSponsor(db, agent.id, sponsor.id);
  }

  // Project each seat's governance state (ADR 070), separate from the identity/mint paths above so
  // reconcile is the single writer of capabilities + the admin account-status override. Effective caps
  // = role defaults ⊕ per-seat narrowing (clampNarrow, never widening); the account-status override is
  // taken straight from the file (provisioned/active are derived at read time, not stored).
  // Count the authority we hold BEFORE projecting, so the check below can tell a LOSS from a team
  // that simply never had an admin. Only the loss is worth saying out loud.
  const adminsBefore = (await listMembers(db, team.id)).filter(
    (m) => resolveCapabilities(m).is_admin,
  ).length;

  for (const { name, seat } of spec.seats) {
    const m = await getMemberByName(db, team.id, name);
    if (!m) continue;
    // Multi-role (ADR 227): the ceiling is the restrictive merge of every held role's defaults.
    // Roster truth is validated on the NEW `roles = [...]` form only — an unknown name there is
    // drift, warned loudly, never a reason to drop the seat (a typo is a warning, not an outage).
    // A legacy bare `role` string stays what it always was: an unvalidated display label (teams
    // use it freely — "tester", "lead" — and flooding them with warnings would teach everyone to
    // ignore the channel that matters).
    const held = seatRoles(seat);
    if (seat.roles !== undefined) {
      for (const r of held) {
        if (!roleDefaults.has(r)) {
          result.errors.push(
            `seat "${name}" names unknown role "${r}" — no roles/${r}.toml declares it; its defaults are ignored`,
          );
        }
      }
    }
    const caps = effectiveCapabilities(
      mergeRoleDefaults(held.map((r) => roleDefaults.get(r) ?? {})),
      seat.capabilities ?? {},
    );
    // Admins can only be humans (ADR 145's authority overlay, made explicit by nick 2026-07-28 in
    // ADR 172)). An agent seat file declaring `is_admin` — directly or via an admin role — is
    // clamped here, at the single writer, and loudly: every admin-gated surface (governance ops,
    // audit reads, risky-lane human review) assumes an admin is a human, so projecting an agent
    // admin would let a seat file quietly manufacture the authority those gates exist to check.
    if (m.kind !== 'human' && caps.is_admin) {
      caps.is_admin = false;
      result.errors.push(
        `seat "${name}" is ${m.kind === 'service' ? 'a service' : 'an agent'} declaring is_admin — clamped to false (admins are human-only, ADR 172)`,
      );
    }
    // ADR 700 decision 3: an agent whose sponsor chain lost standing projects disabled, whatever its
    // own file says — so a file can never re-enable what the cascade took on the same pass.
    let accountStatus = seat.account_status ?? null;
    if (
      sponsorOf.has(name) &&
      (accountStatus === null || !STANDING_LOST.has(accountStatus)) &&
      !(await chainStands(name))
    ) {
      accountStatus = 'disabled';
    }
    await setMemberGovernance(db, m.id, accountStatus, JSON.stringify(caps), held);
  }

  // REMOVE — a live member with no file is soft-tombstoned (never hard-deleted: the message log FK
  // and the audit history require the row to persist; auth already excludes left_at rows).
  const releaseClaims = !(await joinerEnrollment(db, team.id, team.slug));
  for (const m of await listMembers(db, team.id)) {
    // Observer seats (ADR 063) are runtime watchers, not seat files — never tombstone them for being
    // absent from the roster files.
    // The daemon's own service seats (board, policy) have no file either, and are never retired.
    if (m.kind === 'service' && DAEMON_SERVICE_SEATS.has(m.name)) continue;
    if (!desired.has(m.name) && m.observer !== 1) {
      await leaveMember(db, m.id, { releaseClaims });
      result.removed.push(m.name);
    }
  }

  // ADR 700 decision 4: a sponsor this pass took the standing of — its file removed, an admin
  // status, a lapsed `until` — takes its agents' residency, grants, OAuth chains and presence with
  // it, through the one cascade the remove route and the expiry sweep call (ADR 463 §4.2).
  for (const before of sponsorsBefore) {
    const after = await getMemberById(db, before.id);
    if (after && !rowStands(after, now)) {
      await revokeSponsoredDescendants(db, team.id, after, 'reconcile', null, now);
    }
  }

  // A projection that removes the LAST admin is reported, never silently applied. This is the exact
  // shape that took revive's authority on 2026-08-01: `team export` wrote seat files carrying only
  // kind+role, reconcile rebuilt the creator as a plain generalist, and the team was left with no
  // admin at all — with no audit row, and no way back through the API, because every admin-gated
  // route was now closed to everyone. Loud, not fatal, and for the same reason the agent-is_admin
  // clamp above is loud: reconcile's contract is that the files win, so refusing would wedge a
  // roster its owner may have meant to write. Saying so is what was missing.
  if (adminsBefore > 0) {
    const adminsAfter = (await listMembers(db, team.id)).filter(
      (m) => resolveCapabilities(m).is_admin,
    ).length;
    if (adminsAfter === 0) {
      result.errors.push(
        `this roster leaves team "${team.slug}" with NO admin (it had ${adminsBefore}) — every ` +
          `admin-gated route is now closed to everyone, and only a file edit can restore it. Give a ` +
          `human seat a role whose capabilities carry is_admin.`,
      );
    }
  }
  return result;
}

/**
 * Find the roster spec that declares `slug`, if any (ADR 058 per-team cutover). Returns the spec when
 * the team is **file-backed** (some root's `team.toml` carries this slug), else null — the signal the
 * provisioning route uses to choose project-and-return vs. the legacy db-originate path.
 */
export function teamSpecForSlug(roots: string[], slug: string): TeamSpec | null {
  for (const root of roots) {
    let spec: TeamSpec | null = null;
    try {
      spec = loadTeamSpec(root);
    } catch {
      continue; // invalid team.toml — not a usable backing for this slug
    }
    if (spec && spec.team.slug === slug) return spec;
  }
  return null;
}

/**
 * Reconcile every roster root into the one global projection. A team whose `team.toml` is invalid is
 * skipped with its prior projection intact (fail-closed); db-only teams (no root) are never touched.
 */
export async function reconcileAll(db: Driver, roots: string[]): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const root of roots) {
    let spec: TeamSpec | null = null;
    try {
      spec = loadTeamSpec(root);
    } catch (e) {
      log.warn({ msg: 'reconcile_team_invalid', root, err: (e as Error).message });
      continue;
    }
    if (!spec) continue;
    try {
      const result = await reconcileTeam(db, spec);
      // SURFACE what the pass found. Until 2026-08-21 nothing did: `errors` was collected here,
      // returned, asserted in tests, and read by no production caller — so a fail-closed skipped
      // seat, the case load.ts calls "never silently dropped", was in fact reported to nobody. Both
      // channels go to the daemon log now, one line per finding, tagged by kind so a reader can
      // tell a skipped entry from a dropped field.
      for (const err of result.errors) {
        log.warn({ msg: 'reconcile_entry_error', root, team: result.slug, detail: err });
      }
      for (const warning of result.warnings) {
        log.warn({ msg: 'reconcile_key_dropped', root, team: result.slug, detail: warning });
      }
      // ADR 058 guard 2, finally read. `musterd fmt --check` was correct and unrun; two role files
      // drifted for twenty days with nobody aware. Its own line, not folded into `reconcile_key_-
      // dropped`, because untidy bytes and lost data are different findings with different fixes.
      for (const file of result.drift) {
        log.warn({
          msg: 'reconcile_file_drifted',
          root,
          team: result.slug,
          detail: `${file}: not canonical — run \`musterd fmt\` (cosmetic; the entry projected)`,
        });
      }
      results.push(result);
    } catch (e) {
      log.warn({ msg: 'reconcile_failed', root, err: (e as Error).message });
    }
  }
  return results;
}
