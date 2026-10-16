import { createHash, randomBytes } from 'node:crypto';
import {
  type Availability,
  type CredentialMint,
  type Lifecycle,
  type MemberKind,
  type WorkingHours,
  TOKEN_PREFIXES,
} from '@musterd/protocol';
import {
  HUE_MIN_SEPARATION,
  assignHue,
  defaultHue,
  hueConflict,
  nearestClearHue,
} from '@musterd/protocol/hue';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError, SessionLeaseRefused } from '../errors.js';
import { releaseInFlightClaimsForSeat } from './lanes.js';
import { verifyAccess } from './oauth.js';
import type { MemberRow, TeamRow } from './rows.js';
import { parseRoles, resolveAccountStatus, resolveCapabilities } from './rows.js';
import { diagnoseSessionLease, hasValidSessionLease } from './session-leases.js';
import { bootstrapRefusal, findBootstrapCredentialRecord, requireTeam } from './teams.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Bump a member's `updated_at` to now — used as an observer's last-seen for the idle TTL (ADR 064). */
export async function touchSeen(db: Driver, memberId: string): Promise<void> {
  await db.run('UPDATE members SET updated_at = ? WHERE id = ?', [Date.now(), memberId]);
}

/**
 * Reap idle observer seats (ADR 064): hard-delete `observer = 1` members whose `updated_at` predates
 * `idleCutoffTs` and that have no live presence (last seen after `liveCutoffTs`). Skips any observer
 * still referenced by a message (no `to_member` cascade) — left for manual cleanup rather than an FK
 * failure. Presence + cursor rows cascade. Returns the reaped members for logging.
 *
 * The message checks are correlated `NOT EXISTS`, not `NOT IN (SELECT … FROM messages)`: the IN
 * form hashed every tenant's messages on every reaper tick, so the cost grew with the platform
 * (staging 2026-10-06: 15.9 ms vs 0.47 ms; lane 01M49CXMZ5). Same rows — `from_member` is NOT NULL
 * and the old `to_member` subquery already excluded NULL, so NOT IN's NULL trap never applied.
 */
export async function reapStaleObservers(
  db: Driver,
  idleCutoffTs: number,
  liveCutoffTs: number,
): Promise<{ id: string; name: string; team_id: string }[]> {
  const stale = await db.all<{ id: string; name: string; team_id: string }>(
    `SELECT id, name, team_id FROM members
       WHERE observer = 1
         AND updated_at < ?
         AND id NOT IN (SELECT member_id FROM presence WHERE held_until IS NULL AND last_seen_at > ?)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE from_member = members.id)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE to_member = members.id)`,
    [idleCutoffTs, liveCutoffTs],
  );
  if (stale.length > 0) {
    await db.tx(async (t) => {
      for (const m of stale) await t.run('DELETE FROM members WHERE id = ?', [m.id]);
    });
  }
  return stale;
}

/**
 * Cap concurrent idle observers per team (ADR 196): after the ADR 064 TTL pass, keep at most
 * `maxIdlePerTeam` idle (no live presence) observers per team — freshest `updated_at` first —
 * and hard-delete the rest. Same message-FK skip as {@link reapStaleObservers}. Live-connected
 * seats are never capped out. Returns the reaped members for logging.
 */
export async function reapExcessIdleObservers(
  db: Driver,
  maxIdlePerTeam: number,
  liveCutoffTs: number,
): Promise<{ id: string; name: string; team_id: string }[]> {
  if (maxIdlePerTeam < 1) return [];
  const idle = await db.all<{ id: string; name: string; team_id: string; updated_at: number }>(
    `SELECT id, name, team_id, updated_at FROM members
       WHERE observer = 1
         AND left_at IS NULL
         AND id NOT IN (SELECT member_id FROM presence WHERE held_until IS NULL AND last_seen_at > ?)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE from_member = members.id)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE to_member = members.id)
       ORDER BY team_id, updated_at DESC`,
    [liveCutoffTs],
  );
  const excess: { id: string; name: string; team_id: string }[] = [];
  let currentTeam = '';
  let kept = 0;
  for (const row of idle) {
    if (row.team_id !== currentTeam) {
      currentTeam = row.team_id;
      kept = 0;
    }
    if (kept < maxIdlePerTeam) {
      kept += 1;
      continue;
    }
    excess.push({ id: row.id, name: row.name, team_id: row.team_id });
  }
  if (excess.length > 0) {
    await db.tx(async (t) => {
      for (const m of excess) await t.run('DELETE FROM members WHERE id = ?', [m.id]);
    });
  }
  return excess;
}

/**
 * Mint a fresh opaque secret with a typed prefix (`prefix_ + base64url(24 random bytes)`) — the shared
 * scheme for seat tokens (`mskd_`) and the v0.3 P3 agent keys / grants / credentials (ADR 069 decision
 * 1). Always stored as its `hashToken` (sha256-hex); the plaintext is returned once and never persisted
 * or logged. Use the {@link TOKEN_PREFIXES} from `@musterd/protocol` for the prefix.
 */
export function newSecret(prefix: string): string {
  return prefix + randomBytes(24).toString('base64url');
}

function newToken(): string {
  return newSecret('mskd_');
}

/** Set (or clear) a member's credential hash (ADR 076, P3.1). */
export async function setCredentialHash(
  db: Driver,
  memberId: string,
  hash: string | null,
): Promise<void> {
  await db.run('UPDATE members SET credential_hash = ?, updated_at = ? WHERE id = ?', [
    hash,
    Date.now(),
    memberId,
  ]);
}

/** Mint a fresh `mscr_` human credential for a member: store its hash, return the plaintext **once**. */
export async function mintCredential(db: Driver, memberId: string): Promise<CredentialMint> {
  const credential = newSecret(TOKEN_PREFIXES.credential);
  await setCredentialHash(db, memberId, hashToken(credential));
  return { credential };
}

/** Mint a fresh self-identifying credential for an agent Member (ADR 337). */
export async function mintAgentSeatCredential(
  db: Driver,
  memberId: string,
): Promise<{ seat_credential: string }> {
  const member = await getMemberById(db, memberId);
  if (!member || member.kind !== 'agent' || member.observer === 1)
    throw new MusterdError(
      'bad_request',
      'agent-seat credentials may only be minted for agent seats',
    );
  const seat_credential = newSecret(TOKEN_PREFIXES.agent_seat);
  await setCredentialHash(db, memberId, hashToken(seat_credential));
  return { seat_credential };
}

export interface AddMemberInput {
  name: string;
  kind: MemberKind;
  role?: string;
  lifecycle?: Lifecycle;
  lifecycleUntil?: number | null;
  availability?: Record<string, unknown> | null;
  workingHours?: WorkingHours | null;
  slackUserId?: string | null;
  /** The seat's colour (ADR 374). Three statements, not two: a number is stored (refused if it
   *  collides with a live roster member — observers do not occupy that floor, ADR 409); `null`
   *  is "the file has no hue" and is stored as null — reconcile's word, never argued with;
   *  `undefined` is "nobody said" and the daemon assigns, which is right only on a DB-only team,
   *  where the daemon is the source. */
  hue?: number | null;
  /**
   * The hue is the seat FILE's word (reconcile), not a caller's ask: stored as declared, never
   * refused. ADR 058 — the daemon does not argue with the file; a collision is reported back
   * (`hue_shared_with`), not thrown, because a throw here aborts the whole team's reconcile and
   * one hand-edited seat file would wedge every seat on the roster (lane 01M2P43WQ7).
   */
  hueDeclared?: boolean;
  /** ADR 449: the member minting this one. Omitted ⇒ admin/local-peer mint. */
  sponsoredBy?: string | null;
  /** Provision a read-only observer seat (ADR 063): hidden from roster/counts/presence, can't send. */
  observer?: boolean;
  /** Observer grade (ADR 136): `'public'` sees only team/broadcast traffic — what a shared watch-link
   *  gets. Omitted ⇒ `'full'` (the local dashboard). Ignored unless `observer`. */
  observerScope?: 'full' | 'public' | 'broadcast';
}

/** Add a member to a team and mint its one-time token. Returns the row plus the plaintext token. */
export async function addMember(
  db: Driver,
  team: TeamRow,
  input: AddMemberInput,
): Promise<{ row: MemberRow; token: string; hue_shared_with?: string }> {
  if (!input.name || /\s/.test(input.name)) {
    throw new MusterdError(
      'bad_request',
      'member name is required and must not contain whitespace',
    );
  }
  const existing = await getMemberByName(db, team.id, input.name);
  if (existing && existing.left_at === null) {
    throw new MusterdError('conflict', `member "${input.name}" already exists in "${team.slug}"`);
  }
  const lifecycle = input.lifecycle ?? (team.default_lifecycle as Lifecycle);
  if (lifecycle === 'until' && !input.lifecycleUntil) {
    throw new MusterdError('bad_request', 'lifecycle "until" requires a timestamp');
  }
  const { hue, sharedWith } = await resolveHue(
    db,
    team.id,
    input.name,
    input.hue,
    existing?.hue ?? null,
    existing?.id,
    input.hueDeclared === true,
  );
  // A *tombstoned* row (soft-removed, `left_at` set) still squats the (team, name) UNIQUE index, so a
  // plain INSERT would dead-end on a constraint error with no CLI way out — the recurring "departed
  // name can't be reused" trap (ADR 065). Re-adding a removed name is a revive, not a new row: reuse
  // the seat's id (keeps message history continuous) and re-mint the token (ADR 058 `reviveMember`).
  if (existing) {
    const token = await reviveMember(db, existing.id, {
      kind: input.kind,
      role: input.role ?? '',
      lifecycle,
      lifecycleUntil: input.lifecycleUntil ?? null,
      workingHours: input.workingHours ?? null,
      slackUserId: input.slackUserId ?? null,
      hue,
    });
    const row = (await getMemberById(db, existing.id))!;
    return { row, token };
  }
  const token = newToken();
  const now = Date.now();
  const row: MemberRow = {
    id: ulid(),
    team_id: team.id,
    name: input.name,
    kind: input.kind,
    role: input.role ?? '',
    // Projected by reconcile (ADR 227), like capabilities — a fresh seat is NULL (⇒ derived from
    // the single `role` label) until the file-backed roles are reconciled in.
    roles: null,
    lifecycle,
    lifecycle_until: input.lifecycleUntil ?? null,
    availability: input.availability ? JSON.stringify(input.availability) : null,
    working_hours: input.workingHours ? JSON.stringify(input.workingHours) : null,
    slack_user_id: input.slackUserId ?? null,
    hue,
    sponsored_by: input.sponsoredBy ?? null,
    token_hash: hashToken(token),
    // A freshly minted seat is *declared*, not yet *held* — bound_at is stamped on first auth touch
    // (ADR 058). The INSERT omits the column, so it defaults to NULL; kept here for the typed row.
    bound_at: null,
    observer: input.observer ? 1 : 0,
    // Grade is meaningless off an observer seat — keep it NULL there rather than storing a value that
    // reads as if it governs an ordinary member (ADR 136).
    observer_scope: input.observer ? (input.observerScope ?? 'full') : null,
    // Governance is projected by reconcile (ADR 070), not at mint — a fresh seat is NULL (⇒ derived
    // account status + generalist capabilities) until the file-backed values are reconciled in.
    account_status: null,
    capabilities: null,
    credential_hash: null,
    last_offline_reason: null,
    left_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.run(
    `INSERT INTO members
       (id, team_id, name, kind, role, lifecycle, lifecycle_until, availability, working_hours, slack_user_id, hue, sponsored_by, token_hash, observer, observer_scope, account_status, capabilities, left_at, created_at, updated_at)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.team_id,
      row.name,
      row.kind,
      row.role,
      row.lifecycle,
      row.lifecycle_until,
      row.availability,
      row.working_hours,
      row.slack_user_id,
      row.hue,
      row.sponsored_by,
      row.token_hash,
      row.observer,
      row.observer_scope,
      row.account_status,
      row.capabilities,
      row.left_at,
      row.created_at,
      row.updated_at,
    ],
  );
  return { row, token, ...(sharedWith !== null ? { hue_shared_with: sharedWith } : {}) };
}

/** The hues the LIVE roster members of a team hold — the set a new colour must clear.
 *  A departed seat's hue is not held against anyone; neither is an observer's (ADR 409): a
 *  watcher is a session, hidden from the roster, and must not fill the uniqueness floor
 *  `team add` has to walk. `except` leaves the member being recoloured out of its own way. */
export async function takenHues(db: Driver, teamId: string, except?: string): Promise<number[]> {
  return (
    await db.all<{ id: string; hue: number | null }>(
      'SELECT id, hue FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND hue IS NOT NULL',
      [teamId],
    )
  )
    .filter((r) => r.id !== except)
    .map((r) => r.hue!);
}

/**
 * The hue a member ends up with (ADR 374), from what the caller said:
 *   - a number — kept once it clears every live roster member. A collision is refused, naming the
 *     neighbour AND a clear hue, while a clear hue exists; past a full wheel it is kept and the
 *     neighbour is returned as `sharedWith` (lane 01M2P43WQ7 — never a dead-end 409). A DECLARED
 *     hue (the seat file's word) is never refused at all, only reported;
 *   - `null` — kept as null: the seat file has no hue and the daemon never invents one;
 *   - `undefined` — nobody said: keep what the seat already had (a revive), else assign the nearest
 *     clear hue to the name's default. Only a DB-only caller says nothing; reconcile always says.
 */
async function resolveHue(
  db: Driver,
  teamId: string,
  name: string,
  asked: number | null | undefined,
  had: number | null,
  except?: string,
  declared = false,
): Promise<{ hue: number | null; sharedWith: string | null }> {
  if (asked === null) return { hue: null, sharedWith: null };
  if (asked !== undefined) {
    if (!Number.isInteger(asked) || asked < 0 || asked > 359)
      throw new MusterdError('bad_request', `hue must be an integer 0–359, got ${asked}`);
    return {
      hue: asked,
      sharedWith: declared
        ? await hueSharedWith(db, teamId, asked, except)
        : await assertHueClear(db, teamId, asked, except),
    };
  }
  if (had !== null) return { hue: had, sharedWith: null };
  // The name comes from the caller, never from a row lookup: a NEW member has no row yet, and the
  // first cut looked one up by id and seeded every fresh seat from `defaultHue('')` — one colour for
  // everyone, walked apart by `assignHue` so nobody noticed until gptbot read it (#1258 acceptance).
  const hue = assignHue(defaultHue(name), await takenHues(db, teamId, except));
  return { hue, sharedWith: await hueSharedWith(db, teamId, hue, except) };
}

/** The live roster member whose hue sits within `HUE_MIN_SEPARATION` of `hue`, or null. */
export async function hueSharedWith(
  db: Driver,
  teamId: string,
  hue: number,
  except?: string,
): Promise<string | null> {
  const near = hueConflict(hue, await takenHues(db, teamId, except));
  if (near === null) return null;
  const who = await db.get<{ name: string }>(
    'SELECT name FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 AND hue = ?',
    [teamId, near],
  );
  return who?.name ?? '?';
}

/**
 * The uniqueness floor for a hue a CALLER asked for (ADR 374 Decision 3), with the hatch ADR 145
 * demands (lane 01M2P43WQ7): while a clear hue exists, a collision is refused naming the neighbour
 * and one clear hue to take instead; past a full wheel — the greedy walk seats a median 24 at 12° —
 * the hue is kept and the neighbour's name is returned, so the caller can say "colour shared with"
 * out loud exactly as Decision 4's walk does. Returns null when the hue is clear.
 */
export async function assertHueClear(
  db: Driver,
  teamId: string,
  hue: number,
  except?: string,
): Promise<string | null> {
  if (!Number.isInteger(hue) || hue < 0 || hue > 359)
    throw new MusterdError('bad_request', `hue must be an integer 0–359, got ${hue}`);
  const taken = await takenHues(db, teamId, except);
  const near = hueConflict(hue, taken);
  if (near === null) return null;
  const who = await hueSharedWith(db, teamId, hue, except);
  const alternative = nearestClearHue(hue, taken);
  if (alternative === null) return who;
  throw new MusterdError(
    'conflict',
    `hue ${hue} is within ${HUE_MIN_SEPARATION}° of "${who}" (${near}) — ${alternative} is clear`,
  );
}

/** Set a live member's hue in place (the DB-only `team hue` path; ADR 374). */
export async function setMemberHue(
  db: Driver,
  member: MemberRow,
  hue: number,
): Promise<string | null> {
  const sharedWith = await assertHueClear(db, member.team_id, hue, member.id);
  await db.run('UPDATE members SET hue = ?, updated_at = ? WHERE id = ?', [
    hue,
    Date.now(),
    member.id,
  ]);
  return sharedWith;
}

export async function getMemberByName(
  db: Driver,
  teamId: string,
  name: string,
): Promise<MemberRow | undefined> {
  return await db.get<MemberRow>('SELECT * FROM members WHERE team_id = ? AND name = ?', [
    teamId,
    name,
  ]);
}

/**
 * The seat holding a role (ADR 227) — the fallback owner for an unclaimed incident (ADR 271).
 *
 * Two things this does that the inline `WHERE role = ? LIMIT 1` copies in http.ts and ws.ts do not,
 * both of which matter when the answer decides who gets assigned work:
 *
 * - It reads the ADR 227 **roles array**, not only the legacy single `role` column. A seat whose
 *   platform role lives in the JSON is invisible to those copies, and a fallback owner who exists
 *   but cannot be found is indistinguishable from no owner at all.
 * - It is **deterministic**. `LIMIT 1` with no ORDER BY lets SQLite pick, so two seats holding one
 *   role would route by whim and the assignment would not be reproducible from the audit log.
 *
 * Departed seats are skipped: assigning an incident to someone who left is a lane that will never
 * move, and it looks owned on the board while nobody is on it.
 */
export async function getMemberByRole(
  db: Driver,
  teamId: string,
  role: string,
): Promise<MemberRow | undefined> {
  return (
    await db.all<MemberRow>(
      'SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at, id',
      [teamId],
    )
  ).find((row) => parseRoles(row).includes(role));
}

export async function getMemberById(db: Driver, id: string): Promise<MemberRow | undefined> {
  return await db.get<MemberRow>('SELECT * FROM members WHERE id = ?', [id]);
}

export async function listMembers(db: Driver, teamId: string): Promise<MemberRow[]> {
  return await db.all<MemberRow>(
    'SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at',
    [teamId],
  );
}

/**
 * Authenticate a request to a specific member (seat) in a team. Throws unauthorized/forbidden.
 *
 * v0.3 P3 (ADR 077, SPEC A.7) **prefix-dispatch** — the hard cutover removed the v0.2 per-seat token
 * (`mskd_`); the only credentials are:
 *  - `mskey_` (team agent key): authenticates the *harness*, not a seat — so the acting seat must be
 *    named by the caller (`actingSeat`: the Envelope `from` on a send, or the `x-musterd-seat` header on
 *    a read, per SPEC A.7 §253). Authorizes on a valid team key + an existing, active seat. Single-active
 *    occupancy is enforced at *claim* time (the handshake), not re-checked per request — and we
 *    deliberately do **not** gate on live presence / `isHeld`: gating auth on presence would regress the
 *    ambient-presence ergonomics (ADR 057) (a bursty stateless agent past the presence TTL would lock
 *    itself out).
 *  - `mscr_` (human credential): self-identifying — resolves the human seat by `credential_hash`. The
 *    credential is the authority; if `actingSeat` is supplied it must match.
 *  - anything else → `unauthorized` (the `mskd_` path is gone, ADR 069 decision 2).
 */
export async function authMember(
  db: Driver,
  teamSlug: string,
  token: string,
  actingSeat?: string,
  sessionLease?: string,
  opts: {
    /**
     * ADR 408: accept an agent-seat credential with NO session lease. The one route that uses it
     * is `POST /workspace/repair`, posted by the SessionStart hook BEFORE the session has joined —
     * the ADR 164 window in which every lease-gated route is refused. The repair is local and the
     * credential hash alone proves whose workspace it was; a lease would prove nothing extra and
     * would refuse every real post. Every other agent route keeps ADR 337's rule.
     */
    leaseless?: boolean;
  } = {},
): Promise<{ team: TeamRow; member: MemberRow }> {
  const team = await requireTeam(db, teamSlug);
  let member: MemberRow;

  if (token.startsWith(TOKEN_PREFIXES.agent_key)) {
    // A bootstrap key only claims a seat. When this one is revoked or expired — the usual reason a
    // folder holding only a key lands here — say so with the claim refusal's own words and the
    // exact repair, rather than the same "bootstrap-only" for a key that was never the problem.
    const record = await findBootstrapCredentialRecord(db, team.id, token);
    const expired =
      record !== null && record.expires_at !== null && record.expires_at <= Date.now();
    if (record && (record.state === 'revoked' || expired)) {
      const refusal = bootstrapRefusal(record, { expired, retiredLegacy: false });
      throw new MusterdError('unauthorized', `${refusal.message}. ${refusal.hint}`);
    }
    throw new MusterdError(
      'unauthorized',
      'a bootstrap key only claims a seat; routine calls need the seat credential that claim returns. ' +
        'Run `musterd claim <seat>` in this folder. If that says the key is revoked or expired, a team ' +
        'admin runs `musterd team bootstrap mint --seat <seat> --install` on this machine, then claim again',
    );
  } else if (token.startsWith(TOKEN_PREFIXES.agent_seat)) {
    member = await authByAgentSeatCredential(
      db,
      team,
      token,
      actingSeat,
      sessionLease,
      opts.leaseless,
    );
  } else if (token.startsWith(TOKEN_PREFIXES.credential)) {
    member = await authByCredential(db, team, token, actingSeat);
  } else if (token.startsWith(TOKEN_PREFIXES.oauth_access)) {
    // ADR 446: a phone's `msat_` bearer authenticates exactly like an `mscr_` — self-identifying
    // (acting-seat must match-or-absent, checked in authByCredential's sibling below via the
    // shared tail) — with NO session lease: there is no Presence to bind one to. Presence for
    // the roster derives from authenticated activity (ambient, ADR 057), stamped by the caller.
    member = await verifyAccess(db, team.id, token);
    if (actingSeat && actingSeat !== member.name)
      throw new MusterdError(
        'forbidden',
        `access token identifies "${member.name}", not "${actingSeat}"`,
      );
  } else if (token.startsWith(TOKEN_PREFIXES.seat)) {
    member = await authByServiceToken(db, team, token, actingSeat);
  } else {
    // v0.3 hard cutover (ADR 069 decision 2): the v0.2 per-seat token (`mskd_`) auth path is removed
    // for peer seats — the only credentials are the team agent key (`mskey_`), a human credential
    // (`mscr_`), and a service seat's own token (`mskd_`, ADR 232 — kind-bound, see above).
    throw new MusterdError(
      'unauthorized',
      `unrecognized credential for team "${teamSlug}" — present a team agent key (mskey_) or a human credential (mscr_)`,
    );
  }

  const refusal = memberStandingRefusal(member);
  if (refusal) throw refusal;
  return { team, member };
}

/**
 * Whether a member may still act — the one statement, shared by `authMember` (every request) and
 * the OAuth token endpoint (every mint and refresh, ADR 452 §4) so the two cannot drift. Returns
 * the refusal, or null. Departed, disabled/banned/archived, and — ADR 449 §1 — past an `until`
 * lifecycle, compared at use: no sweeper, no grace beyond skew.
 */
export function memberStandingRefusal(member: MemberRow, now = Date.now()): MusterdError | null {
  if (member.left_at !== null)
    return new MusterdError('unauthorized', `seat "${member.name}" has left the team`);
  // ADR 501: a halted seat is refused everywhere with the halter's sentence. Before account status:
  // a halt is the more recent, more specific fact, and it names the human to talk to.
  if (member.halted_at !== null && member.halted_at !== undefined)
    return new MusterdError('forbidden', haltedSentence(member));
  const accountStatus = resolveAccountStatus(member);
  if (accountStatus === 'disabled' || accountStatus === 'banned' || accountStatus === 'archived')
    return new MusterdError('forbidden', `seat "${member.name}" is ${accountStatus}`);
  if (
    member.lifecycle === 'until' &&
    member.lifecycle_until !== null &&
    member.lifecycle_until < now
  )
    return new MusterdError('forbidden', `seat "${member.name}" — membership expired`);
  return null;
}

/** ADR 501: the one sentence every refusal of a halted seat carries. `halted_by` is stored as the
 *  halter's member id; the standing-refusal path has no name to hand, so the halt writes the
 *  NAME into `halted_by` as well — see {@link haltMember}, which stores the name, not the id. */
export function haltedSentence(member: Pick<MemberRow, 'halted_by' | 'halted_reason'>): string {
  return `halted by ${member.halted_by ?? '?'}: ${member.halted_reason ?? ''}`;
}

/**
 * ADR 501 Decision 1: set the halt standing. `by` is the halter's NAME — the sentence is built
 * from the row alone on every refusal path, and a name is what it needs. Returns false when the
 * seat is already halted (the caller answers `conflict`; the first reason stands).
 */
export async function haltMember(
  db: Driver,
  memberId: string,
  by: string,
  reason: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db.run(
    'UPDATE members SET halted_at = ?, halted_by = ?, halted_reason = ?, updated_at = ? WHERE id = ? AND halted_at IS NULL',
    [now, by, reason, now, memberId],
  );
  return r.changes === 1;
}

/** ADR 501 Decision 2: lift the halt. Returns false when the seat was not halted. */
export async function resumeMember(
  db: Driver,
  memberId: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db.run(
    'UPDATE members SET halted_at = NULL, halted_by = NULL, halted_reason = NULL, updated_at = ? WHERE id = ? AND halted_at IS NOT NULL',
    [now, memberId],
  );
  return r.changes === 1;
}

/** Agent HTTP proof is self-identifying and inseparable from its current Presence lease (ADR 337). */
async function authByAgentSeatCredential(
  db: Driver,
  team: TeamRow,
  credential: string,
  actingSeat: string | undefined,
  sessionLease: string | undefined,
  leaseless = false,
): Promise<MemberRow> {
  const member = await db.get<MemberRow>(
    "SELECT * FROM members WHERE team_id = ? AND credential_hash = ? AND left_at IS NULL AND kind = 'agent'",
    [team.id, hashToken(credential)],
  );
  if (!member)
    throw new MusterdError('unauthorized', `invalid agent-seat credential for team "${team.slug}"`);
  if (actingSeat && actingSeat !== member.name)
    throw new MusterdError(
      'forbidden',
      `agent-seat credential identifies "${member.name}", not "${actingSeat}"`,
    );
  // ADR 408: the seat is proven by the credential hash; a leaseless route stops here.
  if (leaseless) return member;
  // ADR 501: a halt revoked this seat's leases on purpose — the refusal must say so, not "dead
  // lease". The seat is proven (credential matched), so the standing sentence is the honest answer.
  if (member.halted_at !== null && member.halted_at !== undefined)
    throw new MusterdError('forbidden', haltedSentence(member));
  // ADR 391: from here down the seat IS proven — the credential matched a live agent row. A lease
  // failure is still a refusal, but it must not throw the proof away with it: the interrupt line
  // needs to say which seat went deaf, and only this function ever knew.
  if (!sessionLease?.startsWith(TOKEN_PREFIXES.session_lease))
    throw new SessionLeaseRefused(member.name, 'missing');
  if (
    !(await hasValidSessionLease(db, { teamId: team.id, memberId: member.id, token: sessionLease }))
  )
    throw new SessionLeaseRefused(
      member.name,
      'dead',
      await diagnoseSessionLease(db, { teamId: team.id, memberId: member.id, token: sessionLease }),
    );
  return member;
}

/**
 * SECURITY — the one statement of the agent-key seat-kind rule: **the shared team agent key may only
 * reach an AGENT seat.**
 *
 * It lives here because the HTTP and WebSocket claim surfaces enforce it and must not drift. The
 * claim surfaces enforced it nowhere until this was extracted: an agent key aimed at the human admin
 * seat was accepted and queued as a pending request (observed: HTTP 202) for an admin to approve.
 * That is the privilege-escalation path the acting check exists to close, reached one step earlier.
 *
 * The claim surfaces must apply this **after** target resolution — a `role` target can resolve to a
 * human seat — and **before** the grant/request branches, so no admin is ever asked to approve a
 * poisoned claim and no pending row leaks.
 */
export function agentKeyMayOccupy(member: Pick<MemberRow, 'kind' | 'observer'>): boolean {
  // Observer seats are minted `kind: 'human'` with `observer: 1` (ADR 063) and are claimed with the
  // team agent key by design — the /live wall and every watch-link are exactly that. They carry no
  // authority to inherit: an observer is hidden from the roster and cannot send, so occupying one
  // escalates nothing. Caught by three observer tests when this guard first read `kind === 'agent'`
  // alone; the rule is about AUTHORITY, not the nominal kind column.
  return member.kind === 'agent' || member.observer === 1;
}

/**
 * The refusal for {@link agentKeyMayOccupy} — shared so every surface says the same thing.
 *
 * Deliberately states what is *refused* rather than what is allowed, because the two callers enforce
 * slightly different rules and one enumeration cannot be true for both: the claim surfaces admit
 * agent **and** observer seats ({@link agentKeyMayOccupy}). An observer is `kind: 'human'` and
 * read-only, so it may be *occupied* with the team key but never use it for a routine action.
 * Naming the refused seat is accurate on both claim surfaces; naming the permitted set is not.
 */
export function agentKeySeatKindRefusal(
  seat: string,
  kind: MemberKind = 'human',
): { message: string; hint: string } {
  // ADR 232: a service seat is equally out of the shared key's reach — its own minted `mskd_`
  // token is its identity, and the hint differs (there is no join flow for a cron).
  if (kind === 'service') {
    return {
      message:
        `the service seat "${seat}" is not reachable with the team agent key; it authenticates ` +
        'with its own service token',
      hint: 'musterd service install delivers the token file (ADR 232)',
    };
  }
  return {
    message:
      `the human seat "${seat}" is not reachable with the team agent key; it authenticates with ` +
      'its own credential',
    hint: `musterd claim ${seat} --team <team> --key mscr_…`,
  };
}

/**
 * Service-token (`mskd_`) auth (ADR 232 §5): self-identifying, **kind-bound to `service`** — the
 * SQL predicate is the guard, exactly like `authByCredential`'s `kind = 'human'`. The `mskd_` seat
 * token has been minted by `addMember`/`reviveMember` all along; the v0.3 cutover removed its auth
 * path for *peer* seats (agents ride the shared team key, humans their credential) and that removal
 * stands. A ledger seat is the one actor with no folder to bind and no human to hold a credential —
 * its own minted token is its identity: no binding, no folder, no shared key. First touch stamps
 * `bound_at` (declared → held), which is what lets ambient presence (ADR 057) derive freshness from
 * its authenticated actions.
 */
async function authByServiceToken(
  db: Driver,
  team: TeamRow,
  token: string,
  actingSeat: string | undefined,
): Promise<MemberRow> {
  const member = await db.get<MemberRow>(
    "SELECT * FROM members WHERE team_id = ? AND token_hash = ? AND left_at IS NULL AND kind = 'service'",
    [team.id, hashToken(token)],
  );
  if (!member)
    throw new MusterdError('unauthorized', `invalid service token for team "${team.slug}"`);
  if (actingSeat && actingSeat !== member.name)
    throw new MusterdError(
      'forbidden',
      `service token identifies "${member.name}", not "${actingSeat}"`,
    );
  await markBound(db, member.id);
  return member;
}

/** Human-credential (`mscr_`) auth: self-identifying; the credential is the authority for its seat. */
async function authByCredential(
  db: Driver,
  team: TeamRow,
  credential: string,
  actingSeat: string | undefined,
): Promise<MemberRow> {
  const member = await db.get<MemberRow>(
    "SELECT * FROM members WHERE team_id = ? AND credential_hash = ? AND left_at IS NULL AND kind = 'human'",
    [team.id, hashToken(credential)],
  );
  if (!member)
    throw new MusterdError('unauthorized', `invalid human credential for team "${team.slug}"`);
  if (actingSeat && actingSeat !== member.name)
    throw new MusterdError(
      'forbidden',
      `credential identifies "${member.name}", not "${actingSeat}"`,
    );
  return member;
}

/** Is this seat currently *held* (someone has authenticated its token)? See {@link authMember}. */
export function isHeld(member: MemberRow): boolean {
  return member.bound_at !== null;
}

/**
 * Does any live seat on the team hold the `is_admin` capability (ADR 071)? The empty-admin fallback for
 * governance routes (reclaim/remove) reads this: a team with **zero** admins stays on the v0.2 open
 * behaviour (any member may operate) so enforcement never breaks an un-migrated team — and self-activates
 * the instant a seat declares admin (creator default, or a seat-file `[capabilities] is_admin = true`).
 */
export async function teamHasAdmin(db: Driver, teamId: string): Promise<boolean> {
  return (await listMembers(db, teamId)).some((m) => resolveCapabilities(m).is_admin);
}

export interface MemberIdentityFields {
  kind: MemberKind;
  role: string;
  lifecycle: Lifecycle;
  lifecycleUntil: number | null;
  workingHours?: WorkingHours | null;
  slackUserId?: string | null;
  /** ADR 374: what the seat file says — a number, or null for "no hue". Reconcile always says. */
  hue?: number | null;
}

/**
 * Update a live member's durable identity in place (ADR 058 reconcile UPDATE path). Preserves `id`,
 * `token_hash`, and `bound_at` — the daemon-private anchors that must survive a reconcile so the
 * message log and any live token stay valid.
 */
export async function updateMemberIdentity(
  db: Driver,
  id: string,
  f: MemberIdentityFields,
): Promise<void> {
  await db.run(
    'UPDATE members SET kind = ?, role = ?, lifecycle = ?, lifecycle_until = ?, working_hours = ?, slack_user_id = ?, hue = ?, updated_at = ? WHERE id = ?',
    [
      f.kind,
      f.role,
      f.lifecycle,
      f.lifecycleUntil,
      f.workingHours ? JSON.stringify(f.workingHours) : null,
      f.slackUserId ?? null,
      f.hue ?? null,
      Date.now(),
      id,
    ],
  );
}

/**
 * Revive a tombstoned seat (ADR 058: file re-added after deletion). Preserves `id` so the message
 * log stays continuous, but **re-mints the token** (deletion was a revocation) and clears `bound_at`
 * back to *declared*. Returns the fresh plaintext token.
 */
export async function reviveMember(
  db: Driver,
  id: string,
  f: MemberIdentityFields,
): Promise<string> {
  const token = newToken();
  await db.run(
    `UPDATE members
       SET kind = ?, role = ?, lifecycle = ?, lifecycle_until = ?,
           working_hours = ?, slack_user_id = ?, hue = ?, token_hash = ?, bound_at = NULL, left_at = NULL, updated_at = ?
     WHERE id = ?`,
    [
      f.kind,
      f.role,
      f.lifecycle,
      f.lifecycleUntil,
      f.workingHours ? JSON.stringify(f.workingHours) : null,
      f.slackUserId ?? null,
      f.hue ?? null,
      hashToken(token),
      Date.now(),
      id,
    ],
  );
  return token;
}

/** Force a held seat back to *declared* without deleting it (operator reclaim / unbind, ADR 058). */
export async function clearBound(db: Driver, id: string): Promise<void> {
  await db.run('UPDATE members SET bound_at = NULL, updated_at = ? WHERE id = ?', [Date.now(), id]);
}

/**
 * Mark a seat *held* (ADR 058): the first time it is occupied, stamp `bound_at`. Idempotent — only sets
 * when still null, so a re-occupy never rotates the original hold time. In v0.2 the first authenticated
 * token touch did this; post-cutover (ADR 069) the claim OCCUPY is the first-occupancy signal, so it
 * calls this — keeping the durable "held" marker and the ADR 070 active derivation intact.
 */
export async function markBound(db: Driver, id: string): Promise<void> {
  await db.run('UPDATE members SET bound_at = ? WHERE id = ? AND bound_at IS NULL', [
    Date.now(),
    id,
  ]);
}

/**
 * Set or clear a member's ceiling (ADR 621 §4–6). Not a capability write: the ceiling is applied at
 * read time by `resolveCapabilities`, so reconcile — the single writer of `capabilities` — cannot
 * widen it. Callers are the invite admit path and the admin-only ceiling route, which audits it.
 */
export async function setMemberCeiling(
  db: Driver,
  id: string,
  ceiling: string | null,
): Promise<void> {
  await db.run('UPDATE members SET ceiling = ?, updated_at = ? WHERE id = ?', [
    ceiling,
    Date.now(),
    id,
  ]);
}

/**
 * Project a seat's governance state onto its member row (ADR 070, v0.3 P1). Kept **separate** from the
 * identity/mint paths so reconcile is the single writer of capabilities + the admin account-status
 * override, and the mint/revive/db-only paths stay untouched (their rows default to NULL ⇒
 * generalist/derived, the backward-compatible state). `accountStatus` is the admin override only
 * (disabled/banned/archived) or NULL; `capabilities` is the resolved effective JSON.
 */
export async function setMemberGovernance(
  db: Driver,
  id: string,
  accountStatus: string | null,
  capabilities: string,
  roles?: string[],
): Promise<void> {
  // `roles` (ADR 227) rides the governance write because reconcile is its single writer, like
  // capabilities; callers that don't project roles (admin routes, tests) leave the column untouched.
  if (roles === undefined) {
    await db.run(
      'UPDATE members SET account_status = ?, capabilities = ?, updated_at = ? WHERE id = ?',
      [accountStatus, capabilities, Date.now(), id],
    );
    return;
  }
  await db.run(
    'UPDATE members SET account_status = ?, capabilities = ?, roles = ?, updated_at = ? WHERE id = ?',
    [accountStatus, capabilities, JSON.stringify(roles), Date.now(), id],
  );
}

/**
 * ADR 449 §3: revoking a member takes every live member whose `sponsored_by` chain reaches them.
 * Sets `account_status = 'disabled'` (the existing refusal the auth paths already honour) without
 * touching capabilities — governance stays reconcile's word elsewhere. Returns the affected rows
 * (the caller audits each, naming the root). Expiry needs no cascade: sponsored members carry
 * their own `lifecycle_until`.
 */
export async function cascadeSponsoredRevocation(
  db: Driver,
  teamId: string,
  rootMemberId: string,
): Promise<MemberRow[]> {
  const affected: MemberRow[] = [];
  const queue = [rootMemberId];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const sponsor = queue.shift()!;
    const children = await db.all<MemberRow>(
      'SELECT * FROM members WHERE team_id = ? AND sponsored_by = ? AND left_at IS NULL',
      [teamId, sponsor],
    );
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      await db.run("UPDATE members SET account_status = 'disabled', updated_at = ? WHERE id = ?", [
        Date.now(),
        child.id,
      ]);
      affected.push(child);
    }
  }
  return affected;
}

/**
 * Re-mint a live seat's token without touching its identity (ADR 058 project-and-return). Used when a
 * declared-but-unheld seat (e.g. one projected from a `git pull`) is claimed: it hands the claimer a
 * fresh token and leaves `bound_at` null until they authenticate. Returns the new plaintext token.
 */
export async function rotateToken(db: Driver, id: string): Promise<string> {
  const token = newToken();
  await db.run('UPDATE members SET token_hash = ?, updated_at = ? WHERE id = ?', [
    hashToken(token),
    Date.now(),
    id,
  ]);
  return token;
}

/**
 * Set (or clear) a member's self-declared availability (SPEC A.6 Axis 2; ADR 044). Reuses the
 * existing `members.availability` TEXT column — JSON-encoded, no migration. Passing `null` returns
 * the member to the implicit-`available` default. Never inferred: only the member's own act sets it.
 */
export async function setAvailability(
  db: Driver,
  memberId: string,
  availability: Availability | null,
): Promise<void> {
  await db.run('UPDATE members SET availability = ?, updated_at = ? WHERE id = ?', [
    availability ? JSON.stringify(availability) : null,
    Date.now(),
    memberId,
  ]);
}

/**
 * `releaseClaims: false` on an enrolled joiner (joiner audit 2026-10-02, lane 01M3ZBTJKD): releasing
 * a lane is a hub-owned ownership edge (ADR 361 §1), and a joiner reconciling the same roster would
 * write a second `lane.released` as `musterd`. The hub's own reconcile releases them, and the
 * reaper's `releaseDepartedSeatClaims` already skips joiner teams for the same reason.
 */
export async function leaveMember(
  db: Driver,
  memberId: string,
  opts: { releaseClaims?: boolean } = {},
): Promise<void> {
  const member = await getMemberById(db, memberId);
  const now = Date.now();
  await db.run(
    "UPDATE members SET left_at = ?, last_offline_reason = 'left_team', updated_at = ? WHERE id = ?",
    [now, now, memberId],
  );
  // ADR 196: soft-remove must free in-flight WIP — otherwise the board asserts ownership for a
  // name every roster filter already drops. awaiting_acceptance keeps the owner (verified-ness).
  if (member && member.left_at === null && opts.releaseClaims !== false) {
    await releaseInFlightClaimsForSeat(db, member.team_id, member.name, now);
  }
}

/** A member the expiry sweeper marked departed. Returned so the caller can audit the roster change. */
export interface SweptMember {
  team_id: string;
  id: string;
  name: string;
  lifecycle_until: number | null;
}

/**
 * Cosmetic expiry sweep (ADR 459 §4, on ADR 449's "roster hygiene" line). Marks `left_at` on
 * members past `lifecycle_until` — auth already refused them, so this changes no decision, only
 * what the roster shows. Never touches unexpiring members, never deletes (the tombstone stays
 * for the name-refusal rules), never releases claims (use `leaveMember` for a real departure).
 * Returns the swept rows; the caller audits them.
 */
export async function sweepExpiredMembers(db: Driver, now = Date.now()): Promise<SweptMember[]> {
  const rows = await db.all<{
    team_id: string;
    id: string;
    name: string;
    lifecycle_until: number | null;
  }>(
    `SELECT team_id, id, name, lifecycle_until FROM members
        WHERE lifecycle = 'until' AND lifecycle_until IS NOT NULL
          AND lifecycle_until <= ? AND left_at IS NULL`,
    [now],
  );
  if (rows.length === 0) return [];
  await db.tx(async (t) => {
    for (const r of rows)
      await t.run('UPDATE members SET left_at = ?, updated_at = ? WHERE id = ?', [now, now, r.id]);
  });
  return rows;
}

/** How often the daemon sweeps expired members off the roster, and how long after boot the first
 *  pass waits (off the boot path — reconcile and the first requests come first). */
export const EXPIRED_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const EXPIRED_SWEEP_FIRST_DELAY_MS = 60 * 1000;

/**
 * The daemon's expiry-sweep loop. A failing pass logs and the loop keeps running — the sweep is
 * hygiene, never load-bearing. Returns the stop function `close()` calls.
 */
export function startExpiredMemberSweep(
  db: Driver,
  onPass: (swept: SweptMember[]) => void | Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  const pass = async () => {
    try {
      // Awaited, so a follow-up that rejects (the daemon's revoke) reaches onError instead of
      // escaping as an unhandled rejection that exits the server (lane 01M3ZC3EXN).
      await onPass(await sweepExpiredMembers(db));
    } catch (err) {
      onError(err);
    }
  };
  const first = setTimeout(pass, EXPIRED_SWEEP_FIRST_DELAY_MS);
  first.unref?.();
  const every = setInterval(pass, EXPIRED_SWEEP_INTERVAL_MS);
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** Sticky offline reason for an intentional seat release (unbind) — ADR 141, presence-honesty §2.3. */
export async function markSeatReleased(db: Driver, memberId: string): Promise<void> {
  await db.run(
    "UPDATE members SET last_offline_reason = 'seat_released', updated_at = ? WHERE id = ?",
    [Date.now(), memberId],
  );
}

/** Sticky offline reason for a clean session exit (graceful release) — presence-honesty §2.3. */
export async function markSessionEnded(db: Driver, memberId: string): Promise<void> {
  await db.run(
    "UPDATE members SET last_offline_reason = 'session_ended', updated_at = ? WHERE id = ?",
    [Date.now(), memberId],
  );
}

export { newToken };
