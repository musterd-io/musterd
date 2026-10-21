import {
  isWireAttestationSource,
  type Provenance,
  type PresenceStatus,
  type Surface,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import { REMOTE_PRESENCE_TTL_MS } from '../config.js';
import type { Driver } from '../db/driver.js';
import { appendAudit, appendReplicatedEvent } from './audit.js';
import type { MemberRow, PresenceRow } from './rows.js';

export interface PresenceSummary {
  member: MemberRow;
  status: PresenceStatus;
  presences: {
    surface: Surface;
    status: PresenceStatus;
    last_seen_at: number;
    provenance: Provenance | null;
    workspace: string | null;
    driver: string | null;
    model: string | null;
    build: string | null;
    epoch: number | null;
    guidance_epoch: number | null;
    style_epoch: string | null;
    wake_lease: string | null;
    /** Why the wake behind `wake_lease` happened (ADR 543); null when not a wake or no lease row. */
    wake_for: {
      edge: string | null;
      lane_id: string | null;
      act_id: string | null;
      act: string | null;
      from: string | null;
    } | null;
    /** The machine this row lives on (presence replication, 2026-09-02); null = this daemon. */
    node: string | null;
    node_label: string | null;
    /** ADR 558 §5 (increment 5): this live occupancy's latest attested hearing (`idle` | `deaf`). */
    hearing: 'idle' | 'deaf' | null;
    hearing_reason: string | null;
  }[];
}

/**
 * The one definition of "live", node-aware (presence replication spec §3): a local row by its own
 * heartbeat, a remote row by its node's last sync contact. Bind `[cutoffLocal, cutoffRemote]` in
 * that order. Requires `presence p LEFT JOIN nodes n ON n.id = p.node` in the FROM clause.
 */
export const LIVE_PRESENCE_SQL =
  'p.held_until IS NULL AND ((p.node IS NULL AND p.last_seen_at > ?) OR (p.node IS NOT NULL AND n.last_seen_at > ?))';

function liveCutoffs(timeoutMs: number, now = Date.now()): [number, number] {
  return [now - timeoutMs, now - REMOTE_PRESENCE_TTL_MS];
}

/** Attach-time context the client may supply (musterd/0.2, ADR 014 + ADR 021 + ADR 101). */
export interface AttachContext {
  provenance?: Provenance | null;
  workspace?: string | null;
  driver?: string | null;
  /** Harness-attested model id (ADR 101). Attested, never verified; absent → null (`unknown`). */
  model?: string | null;
  /** WHICH TIER produced `model` — `observed` | `environment` | `binding`. Rides with `model` and
   *  means nothing without it; absent → null, which honestly says "this row does not know". */
  model_source?: string | null;
  /** Client-attested build ref of the connecting dist (ADR 135); absent → null (unstamped client). */
  build?: string | null;
  /** Client-attested feature epoch (ADR 148); absent → null (older client). The roster's skew signal. */
  epoch?: number | null;
  /** Client-attested guidance epoch of the seat's WORKSPACE (ADR 417) — what it is running, not what
   *  it could write. Absent → null; absence is not an assertion and is never read as epoch 0. */
  guidance_epoch?: number | null;
  /** Client-attested style epoch (ADR 514) — the block this seat is running, 8 hex chars. Same
   *  rule as `guidance_epoch`: absent → null, and absence is never an assertion. */
  style_epoch?: string | null;
  /** The wake lease this session was spawned by (ADR 241), attested from `MUSTERD_WAKE_LEASE`.
   *  Absent → null, and null never matches a verifying lease: absence is not an assertion. */
  wake_lease?: string | null;
}

/** The seat and team behind a member id — every transition names the seat, never the private id. */
async function seatOf(
  db: Driver,
  memberId: string,
): Promise<{ team_id: string; name: string } | undefined> {
  return await db.get<{ team_id: string; name: string }>(
    'SELECT team_id, name FROM members WHERE id = ?',
    [memberId],
  );
}

type DetachReason = 'goodbye' | 'reaped' | 'displaced' | 'cleared';

/**
 * Emit `presence.detached` for LOCAL rows only (`node IS NULL`), then delete them. `where` selects
 * the rows. A remote row is never the subject of a locally emitted transition: this machine did
 * not end that session and must not say it did (presence replication spec §1).
 */
async function detachLocalRows(
  db: Driver,
  where: string,
  params: unknown[],
  reason: DetachReason,
): Promise<void> {
  const rows = await db.all<{ id: string; member_id: string }>(
    `SELECT id, member_id FROM presence WHERE node IS NULL AND ${where}`,
    [...params],
  );
  for (const r of rows) {
    const seat = await seatOf(db, r.member_id);
    if (seat) {
      await appendReplicatedEvent(db, seat.team_id, {
        actor: seat.name,
        action: 'presence.detached',
        target: seat.name,
        result: 'allow',
        detail: { presence: r.id, reason },
      });
    }
    await db.run('DELETE FROM presence WHERE id = ?', [r.id]);
  }
}

/**
 * Create a presence row (a new attachment) for a member on a surface. A member may hold multiple
 * rows at once: agents are kept single-active by the ws hello path (clear-then-attach), while human
 * seats fan out and accumulate live rows (kind-scoped single-active, ADR 042).
 *
 * The row and its `presence.attached` event are one transaction (presence replication, 2026-09-02):
 * the event carries what the roster shows — never `wake_lease`, which identifies rather than
 * describes and does not travel.
 */
export async function attach(
  db: Driver,
  memberId: string,
  surface: Surface,
  connId: string | null,
  ctx: AttachContext = {},
): Promise<PresenceRow> {
  return db.tx(async (t) => {
    const now = Date.now();
    // Back online — clear any sticky offline reason (ADR 141).
    await t.run('UPDATE members SET last_offline_reason = NULL WHERE id = ?', [memberId]);
    const row: PresenceRow = {
      id: ulid(),
      member_id: memberId,
      surface,
      status: 'online',
      conn_id: connId,
      last_seen_at: now,
      held_until: null,
      provenance: ctx.provenance ?? null,
      workspace: ctx.workspace ?? null,
      driver: ctx.driver ?? null,
      model: ctx.model ?? null,
      model_source: ctx.model ? (ctx.model_source ?? null) : null,
      build: ctx.build ?? null,
      epoch: ctx.epoch ?? null,
      guidance_epoch: ctx.guidance_epoch ?? null,
      style_epoch: ctx.style_epoch ?? null,
      wake_lease: ctx.wake_lease ?? null,
      node: null,
      created_at: now,
    };
    await t.run(
      // team_id (v81) comes off the member row in the same statement: the seam's RLS admits the
      // row only when it matches the transaction's tenant, and a stray member id inserts nothing.
      `INSERT INTO presence (id, member_id, team_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, model_source, build, epoch, guidance_epoch, style_epoch, wake_lease, node, created_at)
       SELECT ?, id, team_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM members WHERE id = ?`,
      [
        row.id,
        row.surface,
        row.status,
        row.conn_id,
        row.last_seen_at,
        row.held_until,
        row.provenance,
        row.workspace,
        row.driver,
        row.model,
        row.model_source,
        row.build,
        row.epoch,
        row.guidance_epoch,
        row.style_epoch,
        row.wake_lease,
        row.node,
        row.created_at,
        row.member_id,
      ],
    );
    const seat = await seatOf(t, memberId);
    if (seat) {
      await appendReplicatedEvent(t, seat.team_id, {
        actor: seat.name,
        action: 'presence.attached',
        target: seat.name,
        result: 'allow',
        detail: {
          presence: row.id,
          surface,
          provenance: row.provenance,
          workspace: row.workspace,
          driver: row.driver,
          model: row.model,
          model_source: row.model_source,
          build: row.build,
          epoch: row.epoch,
          guidance_epoch: row.guidance_epoch,
          style_epoch: row.style_epoch,
        },
      });
    }
    return row;
  });
}

/**
 * Release a presence on a clean disconnect: drop the connection but keep the row as a *hold*
 * the same member can reclaim for `graceMs` (single-active, ADR 010). The reaper frees it when
 * `held_until` passes. Held rows are excluded from the live/roster views below.
 * Stamps sticky `disconnected` (ADR 141); during grace `reclaimable` still projects `reconnecting`.
 */
export async function release(db: Driver, presenceId: string, graceMs: number): Promise<void> {
  const now = Date.now();
  const member = await db.get<{ member_id: string }>(
    'SELECT member_id FROM presence WHERE id = ?',
    [presenceId],
  );
  await db.run(
    'UPDATE presence SET conn_id = NULL, last_seen_at = ?, held_until = ? WHERE id = ?',
    [now, now + graceMs, presenceId],
  );
  if (member) {
    // `disconnected` means "ended without a goodbye", so it only fills an empty slot (attach
    // cleared it). A deliberate-exit stamp already placed this session (session_ended via the
    // SessionEnd hook, seat_released via unbind) must survive the socket closing moments later.
    await db.run(
      "UPDATE members SET last_offline_reason = 'disconnected', updated_at = ? WHERE id = ? AND last_offline_reason IS NULL",
      [now, member.member_id],
    );
  }
}

/**
 * Drop every presence row for a member (active or held). Used to keep an **agent** seat
 * single-active on a fresh hello (kind-scoped — humans fan out instead, ADR 042), and to free a
 * seat on operator reclaim/remove (any kind).
 */
export async function clearMemberPresence(db: Driver, memberId: string): Promise<void> {
  await detachLocalRows(db, 'member_id = ?', [memberId], 'cleared');
}

/**
 * ADR 444: is the seat held by a live session a wake claim must not displace? True when any of
 * `presenceIds` (the member's live sockets) backs a row whose provenance is not `wake` — a session a
 * person opened (`session`), or an older adapter that stamps nothing. Only live sockets are passed
 * in: a socketless row is an orphan every claim clears anyway.
 */
export async function heldByAttendedSession(
  db: Driver,
  presenceIds: readonly string[],
): Promise<boolean> {
  return (await attendedSessionRows(db, presenceIds)).length > 0;
}

/** One live row a wake claim must reckon with (ADR 444/609): what it attests and WHEN it attached. */
export interface AttendedSessionRow {
  presenceId: string;
  provenance: string | null;
  created_at: number;
}

/**
 * The live rows behind `presenceIds` that count as attended sessions — provenance not `wake` and
 * not `dream` (a dream is daemon-spawned like a wake, ADR 494) — with the attachment time ADR 609's
 * lease window compares against the lease mint.
 */
export async function attendedSessionRows(
  db: Driver,
  presenceIds: readonly string[],
): Promise<AttendedSessionRow[]> {
  const out: AttendedSessionRow[] = [];
  for (const id of presenceIds) {
    const row = await db.get<{ provenance: string | null; created_at: number }>(
      'SELECT provenance, created_at FROM presence WHERE id = ?',
      [id],
    );
    if (row !== undefined && row.provenance !== 'wake' && row.provenance !== 'dream') {
      out.push({ presenceId: id, provenance: row.provenance ?? null, created_at: row.created_at });
    }
  }
  return out;
}

/** Drop a single presence row by id — used to evict exactly a displaced connection (ADR 068). */
/** What a displaced session was (lane 01M3TB3EY9): its surface, provenance, workspace, and how
 *  long before the displacement it was last seen — the facts `claim.superseded` needs so a wake
 *  landing on a live session is measurable from the ledger alone. */
export interface DisplacedSession {
  presence_id: string;
  surface: string;
  provenance: string | null;
  workspace: string | null;
  last_active_ms: number;
}

/** Read {@link DisplacedSession} for a presence row BEFORE it is cleared; null when already gone. */
export async function describeDisplaced(
  db: Driver,
  presenceId: string,
  now = Date.now(),
): Promise<DisplacedSession | null> {
  const row = await presenceById(db, presenceId);
  if (!row) return null;
  return {
    presence_id: row.id,
    surface: row.surface,
    provenance: row.provenance ?? null,
    workspace: row.workspace ?? null,
    last_active_ms: Math.max(0, now - row.last_seen_at),
  };
}

/** The `superseded` frame's sentence, naming WHAT took the seat (lane 01M3TB3EY9): a wake, a
 *  session, a dream, or — provenance unknown — a newer session; and on which surface. */
export function supersededMessage(
  name: string,
  successor: { provenance?: string | null | undefined; surface?: string | null | undefined },
): string {
  const what = successor.provenance ? `a ${successor.provenance}` : 'a newer session';
  const where = successor.surface ? ` on ${successor.surface}` : '';
  return `your session as "${name}" was taken over by ${what}${where}`;
}

export async function clearPresenceById(db: Driver, presenceId: string): Promise<void> {
  await detachLocalRows(db, 'id = ?', [presenceId], 'displaced');
}

/**
 * Drop a member's *orphaned* presence rows — held or disconnected leftovers with no live socket
 * (`conn_id IS NULL`). A fresh agent hello uses this to clear crashed-session / grace-hold remnants
 * without touching a live same-workspace session it deliberately keeps (ADR 068).
 */
export async function clearOrphanPresence(db: Driver, memberId: string): Promise<void> {
  await detachLocalRows(db, 'member_id = ? AND conn_id IS NULL', [memberId], 'cleared');
}

/**
 * Record that an occupancy was born attesting NOTHING while this member's previous occupancy
 * attested a model (ADR 246) — the de-attestation row. Returns whether one was written.
 *
 * WHY THIS EXISTS. Attestation is sticky WITHIN an occupancy (`model = COALESCE(?, model)` above,
 * and the claim path refuses to clear it) and resets ACROSS one. Both halves are right on their own
 * and the asymmetry is the hole: a new occupancy that attests nothing has no old→new transition to
 * audit, because it was born null — so the seat drops out of the ADR 188 review pool and the ledger
 * cannot say when, or that it happened at all. Measured 2026-08-05: 1214 `occupancy.model_attested`
 * rows, none carrying `new: null`, while `review.ts` has always READ that shape.
 *
 * `new: null` is load-bearing rather than incidental. The durable-attestation reader skips these
 * rows ("a de-attestation proves nothing"), so recording the loss can never become a route for a
 * dead session's model to certify a live review — the thing ADR 187 exists to forbid. This row is a
 * record OF a loss, never a claim about what is running.
 *
 * A seat that has NEVER attested drops nothing: `unknown` from the start is a different fact from
 * "was X, now nothing", and only the second is an event. Without that guard the ledger fills with
 * rows about harnesses that simply cannot attest yet (ADR 158: Codex, today).
 *
 * CONTRACT: callers emit only on a genuinely NEW occupancy — this does not dedupe, because an
 * ambient touch that reuses its row never reaches here and a claim is a new occupancy by definition.
 */
/**
 * Write an occupancy's opening attestation entry — the model it attests, or the fact that it
 * attests nothing (ADR 246). Every claim path calls this and none of them decide the rule
 * themselves.
 *
 * It exists as one function because the `if (model)` branch was duplicated across five claim sites
 * (the WS occupy, three HTTP claim outcomes, and the grant-approval attach), each of which recorded
 * the attested case and silently dropped the unattested one. Five copies of a predicate is how the
 * unattested half stayed invisible for as long as it did — fixing four of five would have left a
 * ledger that is right except where it isn't, which is worse than one that is uniformly incomplete.
 */
export async function recordClaimAttestation(
  db: Driver,
  teamId: string,
  member: { id: string; name: string },
  occupancyId: string,
  model: string | null | undefined,
): Promise<void> {
  if (model) {
    // ADR 101: the initial attestation is the first entry in the occupancy's model history — the
    // audit log IS the switch history (old → new, source), never a table.
    await appendAudit(db, teamId, {
      actor: member.name,
      action: 'occupancy.model_attested',
      target: member.name,
      result: 'allow',
      detail: { occupancy: occupancyId, old: null, new: model, source: 'claim' },
    });
    return;
  }
  await recordUnattestedOccupancy(db, teamId, member, occupancyId, 'claim');
}

export async function recordUnattestedOccupancy(
  db: Driver,
  teamId: string,
  member: { id: string; name: string },
  occupancyId: string,
  source: 'claim' | 'ambient',
): Promise<boolean> {
  const prior = await db.get<{ model: string | null }>(
    'SELECT model FROM presence WHERE member_id = ? AND id != ? AND model IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1',
    [member.id, occupancyId],
  );
  if (!prior?.model) return false;
  await appendAudit(db, teamId, {
    actor: member.name,
    action: 'occupancy.model_attested',
    target: member.name,
    result: 'allow',
    detail: { occupancy: occupancyId, old: prior.model, new: null, source },
  });
  return true;
}

/** Does this member currently hold a *live* (connected, non-held) presence? Drives agent single-active. */
/**
 * ADR 672: is the wake behind `leaseId` live on this seat — a fresh Presence of the member that
 * attests exactly that lease (ADR 241), not released. This is the liveness the spend-approval hold's
 * acts authenticate against in place of a session lease: the wake's own session holds the seat, and
 * the host acting for that wake proves it by the lease the daemon minted for it. A `wake_leases`
 * row cannot say this — it expires 120 s after issue while the wake runs on for minutes.
 */
export async function hasLiveWakePresence(
  db: Driver,
  input: { teamId: string; memberId: string; leaseId: string; freshMs: number },
  now = Date.now(),
): Promise<boolean> {
  // Two facts, both the daemon's: the lease row it minted for THIS member and has not seen reported
  // (a `wake_lease` on a Presence is client-attested, so alone it would let the credential holder
  // name any string), and a fresh Presence attesting it. `expires_at` is not consulted — the row
  // expires 120 s after issue while the wake runs on.
  const row = await db.get<{ id: string }>(
    `SELECT p.id FROM presence p
       JOIN wake_leases w ON w.id = p.wake_lease
       WHERE p.member_id = ? AND p.wake_lease = ? AND p.last_seen_at >= ? AND p.held_until IS NULL
         AND w.team_id = ? AND w.member_id = ? AND w.status <> 'reported'
       LIMIT 1`,
    [input.memberId, input.leaseId, now - input.freshMs, input.teamId, input.memberId],
  );
  return row !== undefined;
}

/**
 * ADR 693: is this member still here — a live presence, or a released one still inside its reclaim
 * grace (a reload or a daemon bounce, not a departure)? False once the reaper would free the seat.
 */
export async function isPresentOrReclaimable(
  db: Driver,
  memberId: string,
  timeoutMs: number,
  now = Date.now(),
): Promise<boolean> {
  if (await hasLivePresence(db, memberId, timeoutMs)) return true;
  const held = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM presence WHERE member_id = ? AND held_until IS NOT NULL AND held_until > ?',
    [memberId, now],
  );
  return (held?.n ?? 0) > 0;
}

export async function hasActivePresence(db: Driver, memberId: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM presence WHERE member_id = ? AND held_until IS NULL AND conn_id IS NOT NULL',
    [memberId],
  );
  return (row?.n ?? 0) > 0;
}

export async function heartbeat(
  db: Driver,
  presenceId: string,
  status?: PresenceStatus,
): Promise<void> {
  if (status) {
    await db.run('UPDATE presence SET last_seen_at = ?, status = ? WHERE id = ?', [
      Date.now(),
      status,
      presenceId,
    ]);
  } else {
    await db.run('UPDATE presence SET last_seen_at = ? WHERE id = ?', [Date.now(), presenceId]);
  }
}

export async function detach(db: Driver, presenceId: string): Promise<void> {
  await detachLocalRows(db, 'id = ?', [presenceId], 'goodbye');
}

/**
 * Ambient presence (ADR 057): a connectionless liveness touch written when a member runs an
 * authenticated command, so a bursty one-shot agent reads present instead of offline between watch
 * sockets. Liveness only — the `working: <x>` label still comes solely from a status_update
 * (two-clocks rule, ADR 010).
 *
 * Three invariants hold it together:
 *  - **No-op under a resident session.** If the member already holds a live *connected* presence (a
 *    real socket), its heartbeat owns liveness; we add nothing (ambient is the fallback for one-shots).
 *  - **Upsert, never append.** Refresh the member's single connectionless, non-held row (or create one
 *    if absent) — a thousand commands leave one ambient row, not a thousand to reap. The explicit
 *    `POST /presence` ping keeps its own row-per-call behavior and is not routed here.
 *  - **Never displaces.** It only writes its own `conn_id = NULL` row; it never closes a socket or
 *    clears rows, so newest-session-wins (ADR 017) stays the only eviction path.
 *
 * Returns true when this touch flipped the member from no-live-presence to present (an offline→online
 * transition), so the caller can emit a presence event to live watchers.
 */
export async function touchAmbientPresence(
  db: Driver,
  memberId: string,
  surface: Surface,
  timeoutMs: number,
  ctx: AttachContext = {},
): Promise<boolean> {
  return (await touchAmbientPresenceRows(db, memberId, surface, timeoutMs, ctx)).flipped;
}

/** The member's ambient row, as `touchAmbientPresenceRows` reports it on either side of the touch. */
export interface AmbientRow {
  id: string;
  model: string | null;
}

/**
 * `touchAmbientPresence`, also reporting the ambient row before and after the touch — what
 * `authTouch` compares to audit a model change (ADR 246). `after` is DERIVED from the write rather
 * than read back: an update keeps the row's id and COALESCEs the model, an attach returns its row,
 * and a no-op leaves `before` standing. Every authenticated request runs this (lane 01M4VR41VE: it
 * was 7 of interrupt-check's ~14 statements on Postgres, each its own three-round-trip transaction),
 * so it reads the row once and asks the three liveness questions in one statement.
 */
export async function touchAmbientPresenceRows(
  db: Driver,
  memberId: string,
  surface: Surface,
  timeoutMs: number,
  ctx: AttachContext = {},
): Promise<{ flipped: boolean; before: AmbientRow | null; after: AmbientRow | null }> {
  const before =
    (await db.get<AmbientRow>(
      'SELECT id, model FROM presence WHERE member_id = ? AND conn_id IS NULL AND held_until IS NULL AND node IS NULL ORDER BY last_seen_at DESC LIMIT 1',
      [memberId],
    )) ?? null;
  const [liveLocal, liveRemote] = liveCutoffs(timeoutMs);
  const now = await db.get<{ active: number | null; remote: number | null; live: number | null }>(
    `SELECT
       SUM(CASE WHEN p.held_until IS NULL AND p.conn_id IS NOT NULL THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN p.held_until IS NULL AND n.last_seen_at > ? THEN 1 ELSE 0 END) AS remote,
       SUM(CASE WHEN ${LIVE_PRESENCE_SQL} THEN 1 ELSE 0 END) AS live
     FROM presence p LEFT JOIN nodes n ON n.id = p.node WHERE p.member_id = ?`,
    [Date.now() - REMOTE_PRESENCE_TTL_MS, liveLocal, liveRemote, memberId],
  );
  const untouched = { flipped: false, before, after: before };
  // A live resident session (real socket) already owns liveness — don't add a competing row
  // (`hasActivePresence`).
  if (Number(now?.active ?? 0) > 0) return untouched;
  // Nor under a live REMOTE row (joiner audit 2026-10-02, lane 01M3ZBTJKD): the member is present
  // on the machine its seat lives on. Writing a local row here would push a presence event the hub
  // refuses for a seat bound elsewhere (ADR 360), and the old pick below, which did not filter on
  // `node`, overwrote the folded remote row's surface/driver/workspace instead. Live by its NODE's
  // heartbeat, the rule every remote-row reader uses (presence replication §3).
  if (Number(now?.remote ?? 0) > 0) return untouched;
  const wasLive = Number(now?.live ?? 0) > 0; // `hasLivePresence`
  // SPEC.md §"Attach context": provenance is a fact known only to the attaching client, and the
  // server MUST NOT guess it. This used to default to `session`, which made an unstated provenance
  // indistinguishable from a declared one — and it landed on humans every time, since `ambientTouch`
  // reads the header for agent seats only (ADR 121). Absence is not an assertion (ADR 236).
  const provenance: Provenance | null = ctx.provenance ?? null;
  const existing = before;
  let after: AmbientRow;
  if (existing) {
    // Model attestation is **sticky** across ambient touches (ADR 101): an authenticated HTTP request
    // carries no model, so `COALESCE(?, model)` preserves the value attested at claim instead of
    // clearing it (attestation only moves forward — a real switch comes via a claim/heartbeat that
    // *does* carry a model). ADR 119: when the client *does* send a model (`x-musterd-model`), COALESCE
    // installs it on a fresh or blank ambient row — the fire-and-exit CLI re-attest path.
    // provenance/workspace/driver stay per-session seed and re-write normally — and `wake_lease`
    // (ADR 241) rides with provenance rather than with model, deliberately. The two answer one
    // question together ("which session animates this row, and what caused it"), so a touch that
    // re-writes provenance must re-write the token in the same breath; a sticky token under a
    // fresh provenance would claim a lease the session no longer belongs to.
    await db.run(
      // `model_source` is COALESCEd on the SAME condition as `model` (`ctx.model ? … : null`), so the
      // pair moves or stays together. Sticky-independently would be worse than not recording it: a
      // new model under a stale tier is a stamp that lies about its own provenance.
      'UPDATE presence SET last_seen_at = ?, status = ?, surface = ?, provenance = ?, workspace = ?, driver = ?, wake_lease = ?, model = COALESCE(?, model), model_source = COALESCE(?, model_source), build = COALESCE(?, build), epoch = COALESCE(?, epoch), guidance_epoch = COALESCE(?, guidance_epoch), style_epoch = COALESCE(?, style_epoch) WHERE id = ?',
      [
        Date.now(),
        'online',
        surface,
        provenance,
        ctx.workspace ?? null,
        ctx.driver ?? null,
        ctx.wake_lease ?? null,
        ctx.model ?? null,
        ctx.model ? (ctx.model_source ?? null) : null,
        ctx.build ?? null,
        ctx.epoch ?? null,
        // ADR 417. COALESCE like its siblings, but for a different reason: `epoch` is sticky because a
        // compiled-in constant CANNOT change mid-occupancy, while this one can and is expected to — a
        // refresh rewrites the seat's files under a live session. So a heartbeat carrying a value moves
        // the row forward, and one carrying none leaves the last attested value standing.
        ctx.guidance_epoch ?? null,
        // ADR 514: the style epoch moves the same way, for the same reason.
        ctx.style_epoch ?? null,
        existing.id,
      ],
    );
    after = { id: existing.id, model: ctx.model ?? existing.model };
  } else {
    // `attach` clears `last_offline_reason` itself, so the update below is for the refresh path only.
    const row = await attach(db, memberId, surface, null, { ...ctx, provenance });
    after = { id: row.id, model: row.model };
  }
  if (!wasLive && existing) {
    await db.run('UPDATE members SET last_offline_reason = NULL WHERE id = ?', [memberId]);
  }
  return { flipped: !wasLive, before, after };
}

/** Does this member currently have any live presence (within timeout, not a release hold)? */
export async function hasLivePresence(
  db: Driver,
  memberId: string,
  timeoutMs: number,
): Promise<boolean> {
  const [l, r] = liveCutoffs(timeoutMs);
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM presence p LEFT JOIN nodes n ON n.id = p.node WHERE p.member_id = ? AND ${LIVE_PRESENCE_SQL}`,
    [memberId, l, r],
  );
  return (row?.n ?? 0) > 0;
}

/** What a team read needs from each member's presence rows: live now, and its latest attested model. */
export interface MemberOccupancy {
  /** Any live presence (within timeout, not a release hold) — `hasLivePresence`. */
  live: boolean;
  /** The model of its most recent non-held presence row, or null (ADR 101/158). */
  model: string | null;
}

/**
 * `hasLivePresence` and the latest attested model for EVERY member of a team, in one statement
 * (lane 01M46RPQ94): asked per member they were two transactions per member on Postgres inside each
 * `/report` derivation. Members with no non-held presence row are absent from the map.
 */
export async function teamOccupancy(
  db: Driver,
  teamId: string,
  timeoutMs: number,
): Promise<Map<string, MemberOccupancy>> {
  const [l, r] = liveCutoffs(timeoutMs);
  const rows = await db.all<{ member_id: string; model: string | null; live: number }>(
    `SELECT p.member_id AS member_id, p.model AS model, CASE WHEN ${LIVE_PRESENCE_SQL} THEN 1 ELSE 0 END AS live FROM presence p JOIN members m ON m.id = p.member_id LEFT JOIN nodes n ON n.id = p.node WHERE m.team_id = ? AND p.held_until IS NULL ORDER BY p.last_seen_at DESC`,
    [l, r, teamId],
  );
  const out = new Map<string, MemberOccupancy>();
  for (const row of rows) {
    const seen = out.get(row.member_id);
    // Rows arrive newest first, so the first row per member carries its latest model.
    if (!seen) out.set(row.member_id, { live: Number(row.live) === 1, model: row.model });
    else if (Number(row.live) === 1) seen.live = true;
  }
  return out;
}

/**
 * How many distinct members hold a *live* presence right now, across **all** teams in this db.
 * The daemon hosts every team, so this cross-team count is the honest answer to "who is connected"
 * — used by the CLI's `service stop|restart` guard (ADR 047) to refuse bouncing a shared daemon out
 * from under a teammate. Counts members, not rows: a member fanned out over two surfaces is one
 * session. Mirrors the live filter used by the roster (fresh heartbeat, not a release hold).
 */
export async function countLivePresences(db: Driver, timeoutMs: number): Promise<number> {
  const [l, r] = liveCutoffs(timeoutMs);
  // Observer seats (ADR 063) watch without participating — never counted as live sessions.
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT p.member_id) AS n FROM presence p JOIN members m ON m.id = p.member_id LEFT JOIN nodes n ON n.id = p.node WHERE m.observer = 0 AND ${LIVE_PRESENCE_SQL}`,
    [l, r],
  );
  return row?.n ?? 0;
}

/**
 * The set of `driver` names carried by a *live* presence right now on this team (ADR 021 co-presence,
 * activated by ADR 155 Increment 1). A driver names the human steering a live agent session; this is
 * how the roster derives "steering marks you working" — a human whose name is in this set composes as
 * `working`/present even without their own heartbeat, computed at read time, no synthetic presence row.
 * Same live filter as the roster (fresh heartbeat, not a release hold), scoped to the team.
 */
export async function listLiveDrivers(
  db: Driver,
  teamId: string,
  timeoutMs: number,
): Promise<Set<string>> {
  const [l, r] = liveCutoffs(timeoutMs);
  const rows = await db.all<{ driver: string }>(
    `SELECT DISTINCT p.driver AS driver FROM presence p JOIN members m ON m.id = p.member_id LEFT JOIN nodes n ON n.id = p.node WHERE m.team_id = ? AND p.driver IS NOT NULL AND ${LIVE_PRESENCE_SQL}`,
    [teamId, l, r],
  );
  return new Set(rows.map((r) => r.driver));
}

/** One live presence row as the roster reads it: the row, its node's label, and its wake's why. */
type LivePresenceRow = PresenceRow & {
  node_label: string | null;
  wake_id: string | null;
  wake_edge: string | null;
  wake_lane_id: string | null;
  wake_act_id: string | null;
  wake_act: string | null;
  wake_from: string | null;
};

/** Roster presence summary for a team. A member is online if any fresh presence; else offline. */
export async function listPresence(
  db: Driver,
  teamId: string,
  timeoutMs: number,
): Promise<PresenceSummary[]> {
  const [l, r] = liveCutoffs(timeoutMs);
  const members = await db.all<MemberRow>(
    'SELECT * FROM members WHERE team_id = ? AND left_at IS NULL AND observer = 0 ORDER BY created_at',
    [teamId],
  );
  // Every member's live presences in ONE statement, grouped here (lane 01M3ZCTQK9): a query per
  // member is a transaction per member on Postgres, and the roster runs this on every /live refetch.
  // The global last_seen_at order survives the grouping, so each member's list keeps its order.
  // A woken row also carries why (ADR 543): its lease's edge/lane/act, and that act's kind and
  // sender. Ids and names only — the roster answers anonymous reads. A lease minted on another node
  // has no row here, so a replicated presence reads `wake_for: null`, never a guess.
  const live = await db.all<LivePresenceRow>(
    `SELECT p.*, n.label AS node_label, w.id AS wake_id, w.edge AS wake_edge, w.lane_id AS wake_lane_id, w.act_id AS wake_act_id, wm.act AS wake_act, wf.name AS wake_from FROM presence p JOIN members m ON m.id = p.member_id LEFT JOIN nodes n ON n.id = p.node LEFT JOIN wake_leases w ON w.id = p.wake_lease AND w.team_id = m.team_id LEFT JOIN messages wm ON wm.id = w.act_id AND wm.team_id = m.team_id LEFT JOIN members wf ON wf.id = wm.from_member WHERE m.team_id = ? AND m.left_at IS NULL AND m.observer = 0 AND ${LIVE_PRESENCE_SQL} ORDER BY p.last_seen_at DESC`,
    [teamId, l, r],
  );
  const byMember = new Map<string, LivePresenceRow[]>();
  for (const p of live) {
    const list = byMember.get(p.member_id);
    if (list) list.push(p);
    else byMember.set(p.member_id, [p]);
  }
  const hearingByMember = await latestHearingByMember(db, teamId, members, byMember);
  return members.map((member) => {
    const presences = byMember.get(member.id) ?? [];
    const status: PresenceStatus =
      presences.length === 0
        ? 'offline'
        : presences.some((p) => p.status === 'online')
          ? 'online'
          : 'away';
    const hearing = hearingByMember.get(member.id) ?? null;
    return {
      member,
      status,
      presences: presences.map((p, idx) => ({
        surface: p.surface as Surface,
        status: p.status,
        last_seen_at: p.last_seen_at,
        provenance: (p.provenance as Provenance | null) ?? null,
        workspace: p.workspace ?? null,
        driver: p.driver ?? null,
        model: p.model ?? null,
        // The tier rides only beside a model, and only when it is a tier this wire knows: a row
        // holding a value no client of ours ever wrote is read as "unknown", not passed through.
        model_source: p.model && isWireAttestationSource(p.model_source) ? p.model_source : null,
        build: p.build ?? null,
        epoch: p.epoch ?? null,
        guidance_epoch: p.guidance_epoch ?? null,
        style_epoch: p.style_epoch ?? null,
        wake_lease: p.wake_lease ?? null,
        wake_for: p.wake_id
          ? {
              edge: p.wake_edge,
              lane_id: p.wake_lane_id,
              act_id: p.wake_act_id,
              act: p.wake_act,
              from: p.wake_from,
            }
          : null,
        attached_at: p.created_at,
        node: p.node ?? null,
        node_label: p.node_label ?? null,
        hearing: idx === 0 && hearing ? hearing.hearing : null,
        hearing_reason: idx === 0 && hearing ? hearing.reason : null,
      })),
    };
  });
}

/**
 * ADR 558 §5 (increment 5): the latest `presence.hearing` row for each live agent's current
 * occupancy (at or after `presence.created_at`, or matching `detail.occupancy`). One query for the
 * team's live agents; absent for a session that never attested hearing (an older adapter, or a
 * CLI-only presence).
 */
export async function latestHearingByMember(
  db: Driver,
  teamId: string,
  members: readonly MemberRow[],
  byMember: ReadonlyMap<string, readonly { id: string; created_at: number }[]>,
): Promise<Map<string, { hearing: 'idle' | 'deaf'; reason: string | null }>> {
  const out = new Map<string, { hearing: 'idle' | 'deaf'; reason: string | null }>();
  const liveAgents = members.filter(
    (m) => m.kind === 'agent' && (byMember.get(m.id)?.length ?? 0) > 0,
  );
  if (liveAgents.length === 0) return out;
  const minCreated = Math.min(...liveAgents.map((m) => byMember.get(m.id)![0]!.created_at));
  const rows = await db.all<{ target: string | null; detail: string | null; ts: number }>(
    `SELECT target, detail, ts FROM audit
      WHERE team_id = ? AND action = 'presence.hearing' AND ts >= ?
      ORDER BY ts ASC, id ASC`,
    [teamId, minCreated],
  );
  const byName = new Map(liveAgents.map((m) => [m.name, m]));
  for (const r of rows) {
    if (!r.target || !r.detail) continue;
    const member = byName.get(r.target);
    if (!member) continue;
    const newest = byMember.get(member.id)?.[0];
    if (!newest || r.ts < newest.created_at) continue;
    try {
      const parsed = JSON.parse(r.detail) as {
        occupancy?: unknown;
        hearing?: unknown;
        reason?: unknown;
      };
      if (typeof parsed.occupancy === 'string' && parsed.occupancy !== newest.id) continue;
      if (parsed.hearing !== 'idle' && parsed.hearing !== 'deaf') continue;
      out.set(member.id, {
        hearing: parsed.hearing,
        reason:
          parsed.hearing === 'deaf' && typeof parsed.reason === 'string' && parsed.reason
            ? parsed.reason.slice(0, 80)
            : null,
      });
    } catch {
      // ignore unparseable audit detail
    }
  }
  return out;
}

/**
 * ADR 558 §5 (increment 5): is this member currently live and deaf? Returns the deaf reason (or
 * null when deaf with no reason), or undefined when the member is offline, hearing (`idle`), or
 * has never attested hearing.
 */
export async function liveDeafReason(
  db: Driver,
  teamId: string,
  member: MemberRow,
  timeoutMs: number,
): Promise<{ deaf: true; reason: string | null } | null> {
  if (member.kind !== 'agent') return null;
  const [l, r] = liveCutoffs(timeoutMs);
  const newest = await db.get<{ id: string; created_at: number }>(
    `SELECT p.id AS id, p.created_at AS created_at
       FROM presence p LEFT JOIN nodes n ON n.id = p.node
      WHERE p.member_id = ? AND ${LIVE_PRESENCE_SQL}
      ORDER BY p.last_seen_at DESC LIMIT 1`,
    [member.id, l, r],
  );
  if (!newest) return null;
  const map = await latestHearingByMember(db, teamId, [member], new Map([[member.id, [newest]]]));
  const h = map.get(member.id);
  return h?.hearing === 'deaf' ? { deaf: true, reason: h.reason } : null;
}

/**
 * Member ids on this team that are *held within their reclaim grace* right now (ADR 010) — a release
 * hold (`held_until` still in the future) the same member can reclaim. Distinct from live presence:
 * these read `offline` on the roster ({@link listPresence} excludes held rows), but the seat is a
 * **reservation**, not a vacancy — surfaced as `MemberSummary.reclaimable` so the clobber guard (ADR
 * 066/105) treats it as occupied. This is the one *positive* read of held rows; every other query
 * filters them out. `now` is passed in so the caller aligns it with its other clocks.
 */
export async function listReclaimableMemberIds(
  db: Driver,
  teamId: string,
  now: number,
): Promise<Set<string>> {
  const rows = await db.all<{ id: string }>(
    'SELECT DISTINCT p.member_id AS id FROM presence p JOIN members m ON m.id = p.member_id WHERE m.team_id = ? AND m.left_at IS NULL AND p.held_until IS NOT NULL AND p.held_until > ?',
    [teamId, now],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Remove dead presence rows — stale live ones (no heartbeat past the timeout) and release holds
 * whose reclaim grace has expired. Returns the removed rows (for offline events).
 *
 * `watchedSince` is when this reaper's current unbroken run began (ADR 236's `continuousSince`).
 * Silence is only evidence over time something was listening: while the daemon is down or suspended
 * no socket can heartbeat and no grace can be proven, so at resumption EVERY local row looks stale
 * at once — and because a session lease is only valid while its presence row lives
 * (`hasValidSessionLease` joins on it), reaping them cascades into every live agent's authority
 * dying with no revocation row to explain it. So the resumed loop judges nobody until it has
 * watched for a full timeout window, which is the same window a live adapter needs to reconnect.
 * The default of 0 means "always been watching" — callers with no continuity to declare are
 * unaffected. Measured 2026-09-02: seats saw "invalid, expired, or revoked agent session lease"
 * after daemon bounces, with no `claim.superseded` row anywhere (lane 01M1HNY302).
 *
 * `now` is the clock the CALLER's tick started on, and the guard and the cutoff must both run on
 * it. Reading a fresh `Date.now()` here let one tick defeat the guard by itself: the first tick
 * after a 3.6-day host suspend reset `watchedSince`, then blocked ~104s on a wedged daemon, and 51s
 * in this function's own clock said the window had been watched — so the cutoff swept three live
 * sockets whose heartbeats were sitting unread in the socket buffer until that same tick returned
 * (2026-09-14 15:57:46Z, lane 01M2GBPX2S). No heartbeat can be heard inside a tick, so no row can
 * go quiet inside one either.
 */
export async function reapStale(
  db: Driver,
  timeoutMs: number,
  watchedSince = 0,
  now = Date.now(),
): Promise<PresenceRow[]> {
  if (now - watchedSince < timeoutMs) return [];
  const cutoff = now - timeoutMs;
  return db.tx(async (t) => {
    // The heartbeat cutoff is a LOCAL rule: only this machine's sockets and ambient touches animate
    // a local row, so only a local row can go quiet by it.
    const stale = await t.all<PresenceRow>(
      'SELECT * FROM presence WHERE node IS NULL AND (last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?))',
      [cutoff, now],
    );
    await detachLocalRows(
      t,
      'last_seen_at <= ? OR (held_until IS NOT NULL AND held_until <= ?)',
      [cutoff, now],
      'reaped',
    );
    // Remote rows whose node has gone quiet: removed silently — this machine did not end that
    // session and must not say it did (spec §1). The origin's own `detached`, if it ever arrives,
    // deletes nothing and advances the cursor.
    const remoteCutoff = now - REMOTE_PRESENCE_TTL_MS;
    await t.run(
      `DELETE FROM presence WHERE node IS NOT NULL AND id IN (
         SELECT p.id FROM presence p LEFT JOIN nodes n ON n.id = p.node
          WHERE p.node IS NOT NULL AND (n.last_seen_at IS NULL OR n.last_seen_at <= ?))`,
      [remoteCutoff],
    );
    return stale;
  });
}

export async function presenceById(db: Driver, id: string): Promise<PresenceRow | undefined> {
  return await db.get<PresenceRow>('SELECT * FROM presence WHERE id = ?', [id]);
}

/**
 * Re-attest the model on a live occupancy (ADR 101): a mid-occupancy model switch (a `/model`
 * command, a fast-mode toggle) is real, so the adapter may update the attested value. Returns the
 * previous value when it actually changed (the caller audits `occupancy.model_attested` with
 * old → new), undefined when the row is missing or the value is unchanged (no audit noise).
 */
export async function reattestModel(
  db: Driver,
  presenceId: string,
  model: string | null,
  modelSource?: string | null,
): Promise<{ previous: string | null } | undefined> {
  const row = await presenceById(db, presenceId);
  if (!row) return undefined;
  const next = model ?? null;
  // The tier describes the id, so it travels with it. Three cases for `modelSource`:
  //   - a string: the caller knows the tier — store the pair;
  //   - `undefined` with the SAME id: the caller said nothing about the tier (an older client
  //     re-affirming on the heartbeat). Absent means "no change", never a clear, or the first
  //     heartbeat after a claim erases what the claim stored (measured on revive 2026-09-03: every
  //     live occupancy had a model and a NULL tier, and `observed` acts survived exactly one
  //     heartbeat interval);
  //   - `undefined` with a DIFFERENT id: the old tier described a different model and cannot be
  //     inherited — the new id is stored untiered, which reads as "unknown tier" downstream.
  const nextSource = !next
    ? null
    : modelSource !== undefined
      ? modelSource
      : (row.model ?? null) === next
        ? (row.model_source ?? null)
        : null;
  // Compare BOTH: a heal that only corrects the tier (same id, observation now backing what was a
  // declaration) is a real change and must be written, or the stamp keeps under-reporting itself.
  if ((row.model ?? null) === next && (row.model_source ?? null) === nextSource) return undefined;
  await db.run('UPDATE presence SET model = ?, model_source = ? WHERE id = ?', [
    next,
    nextSource,
    presenceId,
  ]);
  await emitReattested(db, presenceId);
  return { previous: row.model ?? null };
}

/**
 * Re-attest the workspace guidance epoch on a live presence (ADR 417). The heartbeat's half of the
 * claim: self-heal runs once, at session start, so a long session outlives the rule it started
 * under — a refresh rewrites the seat's guidance files while it is still connected, and the roster
 * must follow. `undefined`/`null` is NO CHANGE, never a clear: a client too old to attest, or a
 * workspace with nothing to read, is silent, and silence is not an assertion (ADR 236).
 *
 * No audit row by design (ADR 417 §Observability): a guidance epoch is occupancy state, not an
 * event. The `presence.reattested` emit is for the replication fold and live watchers, not a log.
 */
export async function reattestGuidanceEpoch(
  db: Driver,
  presenceId: string,
  guidanceEpoch: number | null | undefined,
): Promise<{ previous: number | null } | undefined> {
  if (guidanceEpoch === undefined || guidanceEpoch === null) return undefined;
  const row = await presenceById(db, presenceId);
  if (!row) return undefined;
  if ((row.guidance_epoch ?? null) === guidanceEpoch) return undefined;
  await db.run('UPDATE presence SET guidance_epoch = ? WHERE id = ?', [guidanceEpoch, presenceId]);
  await emitReattested(db, presenceId);
  return { previous: row.guidance_epoch ?? null };
}

/**
 * Re-attest the style epoch on a live presence (ADR 514) — the `reattestGuidanceEpoch` rule:
 * undefined/null is no change, equal is no write, a change emits `presence.reattested`.
 */
export async function reattestStyleEpoch(
  db: Driver,
  presenceId: string,
  styleEpoch: string | null | undefined,
): Promise<{ previous: string | null } | undefined> {
  if (styleEpoch === undefined || styleEpoch === null) return undefined;
  const row = await presenceById(db, presenceId);
  if (!row) return undefined;
  if ((row.style_epoch ?? null) === styleEpoch) return undefined;
  await db.run('UPDATE presence SET style_epoch = ? WHERE id = ?', [styleEpoch, presenceId]);
  await emitReattested(db, presenceId);
  return { previous: row.style_epoch ?? null };
}

/**
 * `presence.reattested` for a LOCAL row after its model or surface changed (presence replication,
 * 2026-09-02). Carries the whole attestation triple so a peer's fold needs no prior state beyond
 * the row itself. Callers return early when nothing changed, so no duplicate rows.
 */
async function emitReattested(db: Driver, presenceId: string): Promise<void> {
  const after = await presenceById(db, presenceId);
  if (!after || after.node !== null) return;
  const seat = await seatOf(db, after.member_id);
  if (!seat) return;
  await appendReplicatedEvent(db, seat.team_id, {
    actor: seat.name,
    action: 'presence.reattested',
    target: seat.name,
    result: 'allow',
    detail: {
      presence: presenceId,
      model: after.model,
      model_source: after.model_source,
      surface: after.surface,
      guidance_epoch: after.guidance_epoch,
      style_epoch: after.style_epoch,
    },
  });
}

/**
 * Re-attest the occupancy surface on a live presence (ADR 275): occupancy follows capture the
 * same way model does, so a mid-session heal must not keep the claim-time declaration. Returns
 * the previous value when it actually changed; undefined when the row is missing or unchanged
 * (no write). No audit row — `presence.surface` is the instrument (ADR 275 §4).
 */
export async function reattestSurface(
  db: Driver,
  presenceId: string,
  surface: Surface,
): Promise<{ previous: Surface } | undefined> {
  const row = await presenceById(db, presenceId);
  if (!row) return undefined;
  if (row.surface === surface) return undefined;
  await db.run('UPDATE presence SET surface = ? WHERE id = ?', [surface, presenceId]);
  await emitReattested(db, presenceId);
  return { previous: row.surface as Surface };
}

/**
 * The current attested model to stamp on an act (ADR 101). When the sending occupancy is known
 * (`presenceId`, the WS path) the stamp reads **exactly that occupancy's** attestation — a member
 * fanned out over two sessions on different models never cross-attributes (ADR 042). When it isn't
 * (the stateless HTTP message paths, which hold no live occupancy) it falls back to the member's
 * freshest presence that attests a model. Null when nothing attests (`unknown`).
 */
export async function currentAttestedModel(
  db: Driver,
  memberId: string,
  presenceId?: string,
): Promise<string | null> {
  return (await currentAttestation(db, memberId, presenceId)).model;
}

/**
 * The attested model **and the tier that produced it**, read together from one row (ADR 301). Always read as a pair: joining a model from one row to a tier from another is the
 * cross-attribution the `senderPresenceId` key exists to prevent, one field over.
 *
 * `source` is null whenever `model` is null, and may ALSO be null beside a real model — a row
 * written before migration 42, or by a client too old to send it. That null is honest and must not
 * be defaulted to `binding`: "we do not know which tier" is a different fact from "it was a
 * declaration", and guessing collapses exactly the distinction this carries.
 */
/**
 * The adapter build this seat most recently attested (ADR 135's `x-musterd-build`, sticky on the
 * presence row) — the dist a woken session actually runs, read for the wake ledger (lane
 * 01M330CCQE). Null when no presence of this seat ever carried one. Newest presence first, so a
 * fresh wake's row wins over an older live session's.
 */
export async function currentBuild(db: Driver, memberId: string): Promise<string | null> {
  const row = await db.get<{ build: string | null }>(
    'SELECT build FROM presence WHERE member_id = ? AND build IS NOT NULL ORDER BY last_seen_at DESC, id DESC LIMIT 1',
    [memberId],
  );
  return row?.build ?? null;
}

export async function currentAttestation(
  db: Driver,
  memberId: string,
  presenceId?: string,
): Promise<{ model: string | null; source: string | null }> {
  const row = presenceId
    ? await db.get<{ model: string | null; model_source: string | null }>(
        'SELECT model, model_source FROM presence WHERE id = ? AND member_id = ?',
        [presenceId, memberId],
      )
    : await db.get<{ model: string | null; model_source: string | null }>(
        'SELECT model, model_source FROM presence WHERE member_id = ? AND model IS NOT NULL ORDER BY last_seen_at DESC, id DESC LIMIT 1',
        [memberId],
      );
  const model = row?.model ?? null;
  return { model, source: model ? (row?.model_source ?? null) : null };
}
