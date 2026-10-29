import { execFileSync } from 'node:child_process';
import {
  mergeClaims,
  LANE_CLAIMS_MAX,
  type LaneClaim,
  ACCEPTANCE_STALE_MS,
  CALENDAR_DEFAULT_TZ,
  preRegisteredRefusal,
  compareGoals,
  DEFAULT_PROJECT,
  deriveLaneAreas,
  deriveReadStatus,
  emptyPoolFromCandidates,
  isAwaitingAcceptance,
  laneCardColumn,
  LANE_CONTENDING_STATES,
  LANE_TERMINAL_STATES,
  LaneRequestedSchema,
  requestedRecordJson,
  resolveStakesDefault,
  type EmptyPool,
  type BuiltOn,
  type Goal,
  type Lane,
  type LaneCard,
  type LaneMetric,
  type MetricInput,
  type LaneState,
  type LaneWarning,
  type OpenLane,
  type UpdateLane,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { appendLaneEventRequired, type AuditAction, type AuditRow } from './audit.js';
import { stalledContinuationWarning } from './continuationStall.js';
import { listGoals } from './goals.js';
import { pickCardPlace } from './laneCard.js';
import { withSamples } from './laneSamples.js';
import { getPolicy } from './teams.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — store CRUD + the two warn-only contention checks.
 * Declarations only: `scope` ∩ and `depends_on` state are the whole engine (wire token `scope`, ADR 296;
 * the DB column keeps its historical `surface_globs` name — internal, tier 3). Checks are
 * computed live (the board always reflects current state); the *delivery* dedup — warn once until the
 * condition clears or changes — falls out of diffing warnings before/after a mutation (route layer).
 */

interface LaneRow {
  id: string;
  team_id: string;
  project: string;
  title: string;
  detail: string | null;
  /** Lane kind (spec 2026-08-14); null on pre-v41 rows ⇒ ordinary lane. */
  kind: string | null;
  owner_seat: string | null;
  role: string | null;
  surface_globs: string;
  depends_on: string;
  branch: string | null;
  goal_id: string | null;
  /** JSON array of declared risk tags (ADR 169); null on pre-v24 rows ⇒ []. */
  risk: string | null;
  /** Declared acceptance stakes (ADR 234); null on pre-v32 rows ⇒ 'normal' — absence IS the default. */
  stakes: string | null;
  /** Who set `stakes` (ADR 244); null ⇒ 'declared' — every pre-policy lane got its value from a seat
   *  or from silence, and ADR 234 §2 rules that silence IS the worker's declaration. */
  stakes_provenance: string | null;
  /** The worker's merge attestation captured at awaiting_acceptance (ADR 192); null until lane_submit. */
  merged_json: string | null;
  /** Why the lane is parked (ADR 466, v78); null whenever `state !== 'parked'`. */
  parked_json: string | null;
  /** What the close said is left (ADR 487, v81): JSON `"none"` or a lane-id list; null reads as none. */
  follows_up_json: string | null;
  /** Why the lane was dropped (ADR 487, v81). */
  abandon_reason: string | null;
  /** The seat session's unfinished to-dos (ADR 487 §5.2, v82): JSON `{items, at}`; null = none. */
  unfinished_todos_json: string | null;
  /** The issue this lane came from (ADR 561, v91); null = none. */
  source_ref: string | null;
  /** Who asked for the lane (ADR 629, v102): JSON `{by, basis, ref?}`; null = missing. */
  requested_json: string | null;
  /** The day the lane's read is due (ADR 644, v105): `YYYY-MM-DD`; null = undated. */
  reads_on: string | null;
  /** The read's verdict (ADR 644, v105): JSON `{outcome, note, by, at}`; null = none given. */
  read_verdict_json: string | null;
  /** ADR 645 (v106): the pre-registered declaration, JSON `{run, verdict_rule, record, expected_spend, by, at}`; null = not declared. */
  pre_registered_json: string | null;
  /** ADR 673 (v112): what the read measures, JSON `{name, unit, baseline, target, direction, source, by, at}`; null = none. */
  metric_json: string | null;
  /** ADR 751 (v134): the card's place on the wall board, JSON `{x, y, by, at}`; null = off the board. */
  card_json: string | null;
  /** ADR 585 (v95): the claims filed at submit / re-checked at accept; null = none filed. */
  claims_json: string | null;
  /** ADR 582 §3 (v98): explicit area override; null = derive at read time from `surface_globs`. */
  areas_json: string | null;
  /** ADR 624 (v101): the latest decline — `{by, reason, at}` from a release with a reason; cleared
   *  by any claim; null = none. */
  declined_json: string | null;
  state: string;
  created_by: string;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  updated_at: number;
}

function normalizeDeclaredAreas(areas: readonly string[] | null | undefined): string[] | null {
  if (!areas || areas.length === 0) return null;
  const out = deriveLaneAreas([], areas);
  return out.length > 0 ? out : null;
}

function requestedFromJson(raw: string | null): Lane['requested'] {
  if (!raw) return undefined;
  try {
    const parsed = LaneRequestedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** ADR 629: settle a lane_open / lane_update `requested` into the stored record. */
async function resolveRequested(
  db: Driver,
  teamId: string,
  actor: string,
  input: OpenLane['requested'],
): Promise<Lane['requested']> {
  if (!input) return undefined;
  const { by, basis, ref } = input;
  if (!by && !basis && !ref) return undefined;
  if (basis === 'self' || (basis === undefined && !ref && (by === undefined || by === actor))) {
    if (by !== undefined && by !== actor)
      throw new MusterdError('bad_request', 'a self request names the seat who is writing it');
    if (ref) throw new MusterdError('bad_request', 'a self request has no act or seed behind it');
    return { by: actor, basis: 'self' };
  }
  if (basis === 'act') {
    if (!ref) throw new MusterdError('bad_request', 'an act request names the act id');
    const row = await db.get<{ name: string; act: string }>(
      `SELECT members.name AS name, messages.act AS act
         FROM messages JOIN members ON members.id = messages.from_member
        WHERE messages.team_id = ? AND messages.id = ?`,
      [teamId, ref],
    );
    if (!row) throw new MusterdError('not_found', `no act ${ref}`);
    if (row.act !== 'steer' && row.act !== 'ask' && row.act !== 'handoff')
      throw new MusterdError(
        'bad_request',
        `act ${ref} is a ${row.act}; who-asked counts a steer, an ask, or a handoff`,
      );
    if (by !== undefined && by !== row.name)
      throw new MusterdError('bad_request', `act ${ref} was sent by ${row.name}, not ${by}`);
    return { by: row.name, basis: 'act', ref };
  }
  if (basis === 'seed') {
    if (!ref) throw new MusterdError('bad_request', 'a seed request names the seed id');
    // The column is a member id. The lane record stores the name, which is what `Seed.submitted_by`
    // already resolved to, so a caller `by` is that name.
    const row = await db.get<{ name: string }>(
      `SELECT members.name AS name
         FROM seeds JOIN members ON members.id = seeds.submitted_by
        WHERE seeds.team_id = ? AND seeds.id = ?`,
      [teamId, ref],
    );
    if (!row) throw new MusterdError('not_found', `no seed ${ref}`);
    if (by !== undefined && by !== row.name)
      throw new MusterdError('bad_request', `seed ${ref} was submitted by ${row.name}, not ${by}`);
    return { by: row.name, basis: 'seed', ref };
  }
  if (basis === 'stated' || (basis === undefined && by !== undefined && !ref)) {
    if (by === undefined || by === actor)
      throw new MusterdError(
        'bad_request',
        'a stated request names someone other than the seat writing it',
      );
    if (ref)
      throw new MusterdError(
        'bad_request',
        'a stated request has no act or seed; use basis act or seed',
      );
    return { by, basis: 'stated' };
  }
  throw new MusterdError('bad_request', 'say who asked with basis self, stated, act, or seed');
}

/**
 * ADR 673 §1: a metric as the store keeps it — the declaration stamped with who set it and when.
 * Refused without a read day: a number with no verdict day is a dashboard, not an experiment.
 */
function metricRecord(
  input: MetricInput,
  readsOn: string | null | undefined,
  by: string,
  at: number,
): LaneMetric {
  if (!readsOn)
    throw new MusterdError(
      'bad_request',
      'a metric belongs to a dated read: set reads_on (YYYY-MM-DD) with it (ADR 673)',
    );
  return {
    name: input.name,
    unit: input.unit,
    baseline: input.baseline,
    target: input.target,
    direction: input.direction,
    source: input.source ?? 'manual',
    ...(input.harness !== undefined ? { harness: input.harness } : {}),
    by,
    at,
  };
}

/**
 * Lane 01M5ZFZBCD: the wire carries at most LANE_CLAIMS_MAX claims per lane, but the stored list
 * keeps every checker's reading (`mergeClaims`, up to four times that). A lane several seats
 * checked (revive 01M5ASVF3G: 17) then failed the board schema for EVERY reader, which looked like
 * version skew. Served view: one claim per (kind, ref), the newest reading, then the newest
 * LANE_CLAIMS_MAX, in the stored order. A READ view only: the write path merges into, and the
 * close summary counts, the full stored list (`storedClaims`), never this.
 */
export function servedClaims(claims: readonly LaneClaim[]): LaneClaim[] {
  if (claims.length <= LANE_CLAIMS_MAX) return [...claims];
  // One per (kind, ref). The most severe reading wins — a seat's refutation is never hidden behind
  // another seat's later confirmation — and among equals, the newest.
  const severity = (c: LaneClaim) =>
    c.verdict === 'unconfirmed' ? 2 : c.verdict === 'unverifiable' ? 1 : 0;
  const newest = new Map<string, LaneClaim>();
  for (const c of claims) {
    const key = `${c.kind}\u0000${c.ref}`;
    const seen = newest.get(key);
    if (
      !seen ||
      severity(c) > severity(seen) ||
      (severity(c) === severity(seen) && c.checked_at > seen.checked_at)
    )
      newest.set(key, c);
  }
  const kept = new Set(
    [...newest.values()].sort((a, b) => b.checked_at - a.checked_at).slice(0, LANE_CLAIMS_MAX),
  );
  return claims.filter((c) => kept.has(c));
}

/** The full stored claim list — what `mergeClaims` and the close summary must read. */
export async function storedClaims(
  db: Driver,
  teamId: string,
  laneId: string,
): Promise<LaneClaim[]> {
  const row = await db.get<{ claims_json: string | null }>(
    'SELECT claims_json FROM lanes WHERE team_id = ? AND id = ?',
    [teamId, laneId],
  );
  return row?.claims_json ? (JSON.parse(row.claims_json) as LaneClaim[]) : [];
}

function rowToLane(row: LaneRow, teamSlug: string, nowMs: number = Date.now()): Lane {
  const scope = JSON.parse(row.surface_globs) as string[];
  const declaredAreas = row.areas_json ? (JSON.parse(row.areas_json) as string[]) : undefined;
  const requested = requestedFromJson(row.requested_json);
  const readVerdict = row.read_verdict_json
    ? (JSON.parse(row.read_verdict_json) as Lane['read_verdict'])
    : null;
  // ADR 644 §4: derived on every projection, never stored. Absent without `reads_on`.
  const readStatus = deriveReadStatus(
    { reads_on: row.reads_on, read_verdict: readVerdict, state: row.state },
    nowMs,
    CALENDAR_DEFAULT_TZ,
  );
  return {
    id: row.id,
    team: teamSlug,
    project: row.project,
    title: row.title,
    detail: row.detail,
    // Absence reads as "ordinary lane" — same skew posture as stakes below (ADR 148).
    kind: (row.kind as Lane['kind']) ?? null,
    owner_seat: row.owner_seat,
    role: row.role,
    // The DB column keeps its historical `surface_globs` name (internal, ADR 296 tier 3); the
    // epoch-14 wire mirror of that key dropped at epoch 16.
    scope,
    areas: deriveLaneAreas(scope, declaredAreas),
    ...(declaredAreas && declaredAreas.length > 0 ? { declared_areas: declaredAreas } : {}),
    depends_on: JSON.parse(row.depends_on) as string[],
    branch: row.branch,
    goal_id: row.goal_id,
    risk: row.risk ? (JSON.parse(row.risk) as string[]) : [],
    // Absence reads as the default rather than as missing data, so every pre-234 lane keeps its
    // current meaning without a backfill (ADR 148 skew posture).
    stakes: (row.stakes as Lane['stakes']) ?? 'normal',
    // Same skew posture one field over: absence is 'declared', never missing data (ADR 244).
    stakes_provenance: (row.stakes_provenance as Lane['stakes_provenance']) ?? 'declared',
    merged: row.merged_json ? (JSON.parse(row.merged_json) as Lane['merged']) : null,
    state: row.state as LaneState,
    ...(row.parked_json ? { parked: JSON.parse(row.parked_json) as Lane['parked'] } : {}),
    ...(row.follows_up_json
      ? { follows_up: JSON.parse(row.follows_up_json) as Lane['follows_up'] }
      : {}),
    ...(row.abandon_reason ? { abandon_reason: row.abandon_reason } : {}),
    ...(row.unfinished_todos_json
      ? { unfinished_todos: JSON.parse(row.unfinished_todos_json) as Lane['unfinished_todos'] }
      : {}),
    ...(row.source_ref ? { source_ref: row.source_ref } : {}),
    ...(requested ? { requested } : {}),
    ...(row.reads_on ? { reads_on: row.reads_on } : {}),
    ...(readVerdict ? { read_verdict: readVerdict } : {}),
    ...(readStatus ? { read_status: readStatus } : {}),
    ...(row.pre_registered_json
      ? { pre_registered: JSON.parse(row.pre_registered_json) as Lane['pre_registered'] }
      : {}),
    ...(row.metric_json ? { metric: JSON.parse(row.metric_json) as Lane['metric'] } : {}),
    ...(row.card_json ? { card: JSON.parse(row.card_json) as LaneCard } : {}),
    ...(row.claims_json
      ? { claims: servedClaims(JSON.parse(row.claims_json) as LaneClaim[]) }
      : {}),
    ...(row.declined_json ? { declined: JSON.parse(row.declined_json) as Lane['declined'] } : {}),
    created_by: row.created_by,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,
  };
}

/** States that participate in contention (ADR 169: shared constant — includes ready_for_review). */
const CONTENDING: ReadonlySet<string> = LANE_CONTENDING_STATES;

/**
 * Who is making a lane transition, for the `lane.*` row the store writes beside it. Lane-replication
 * spec §Hole 3: a `lane.*` row is not observability, it IS the transition — so it is written inside
 * the same transaction as the lane row, with the required append, and if the record cannot be
 * written the transition does not happen. `messages` has had this property since v1 (the log is
 * the write); it is what makes the audit spine a substrate a peer can fold rather than a
 * best-effort shadow. Callers that own their own verb (`recordLaneClose`, `lane.ready_for_review`)
 * pass nothing and write theirs as before.
 */
export interface LaneAudit {
  actor: string | null;
  /**
   * Federation 3c: the node the acting seat resides on, when the transition was arbitrated by the
   * hub on a joiner's behalf (the claim since ADR 355; every ownership/state edge since ADR 361).
   * Recorded on every `lane.*` row the write produces — the residence TRACE in the replicated
   * log (the binding itself is `seat_nodes`, ADR 355 §5). Absent for a local transition.
   */
  node?: string;
}

async function laneAuditRow(
  db: Driver,
  teamId: string,
  audit: LaneAudit,
  action: AuditAction,
  laneId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await appendLaneEventRequired(db, teamId, {
    actor: audit.actor,
    action,
    target: laneId,
    result: 'allow',
    detail: { ...(audit.node !== undefined ? { node: audit.node } : {}), ...detail },
  });
}

/**
 * The four edges the store records, with the same exclusivity the PATCH handler used to apply —
 * moved here, not duplicated, so the predicates cannot drift (ryder, #1071 acceptance). Terminal
 * edges belong to `recordLaneClose`. Entering awaiting_acceptance belongs to `lane.ready_for_review`
 * on the origin; a hub-arbitrated submit also records `lane.state_changed` so the fold can apply
 * the state (lane 01M2HNSVA79).
 */
async function recordLaneEdges(
  db: Driver,
  teamId: string,
  before: Lane,
  after: Lane,
  ownerPatched: boolean,
  audit: LaneAudit,
  /** ADR 624: the patch fields the edges record — the pick on a claim, the reason on a release. */
  edge: {
    pick?: UpdateLane['pick'];
    release_reason?: string | undefined;
    /** ADR 644: the patch carried a verdict — the write itself is what the trace row counts. */
    read_verdict_written?: boolean;
  } = {},
): Promise<void> {
  const claimed =
    ownerPatched && after.owner_seat !== null && after.owner_seat !== before.owner_seat;
  if (claimed) {
    await laneAuditRow(db, teamId, audit, 'lane.claimed', after.id, {
      lane: after.id,
      owner: after.owner_seat,
      previous_owner: before.owner_seat,
      // A handoff and a self-claim are the same patch; only the record can tell them apart later.
      kind: after.owner_seat === audit.actor ? 'claim' : 'handoff',
      ...(before.owner_seat ? { takeover_of_offline_owner: true } : {}),
      // ADR 624: a lane-picker pick, verbatim — `attested` says how strongly "who asked" is proven.
      ...(edge.pick ? { pick: edge.pick } : {}),
    });
  }
  const changed = laneFieldChanges(before, after);
  if (changed.length > 0) {
    await laneAuditRow(db, teamId, audit, 'lane.updated', after.id, {
      lane: after.id,
      fields: changed,
      changes: laneFieldDiff(before, after),
    });
  }
  // ADR 644 §2: one row per verdict WRITE, carrying what it replaced. Keyed on the write, not on the
  // stamp: `at` comes from the request clock, so two writes in one millisecond (or a repeat of the
  // same verdict) would otherwise leave no row, and the 30-day eval counts these rows.
  // `lane.updated` above already replicates the verdict itself.
  if (edge.read_verdict_written && after.read_verdict) {
    await laneAuditRow(db, teamId, audit, 'lane.read_recorded', after.id, {
      lane: after.id,
      reads_on: after.reads_on ?? null,
      outcome: after.read_verdict.outcome,
      by: after.read_verdict.by,
      at: after.read_verdict.at,
      previous_outcome: before.read_verdict?.outcome ?? null,
      ...(after.read_verdict.measured ? { measured: after.read_verdict.measured } : {}),
      ...(after.read_verdict.evidence ? { evidence: after.read_verdict.evidence } : {}),
    });
  }
  // ADR 673 §1: a moved goalpost is on the record — target or direction changed on a lane that
  // already had a metric.
  if (
    before.metric &&
    after.metric &&
    (before.metric.target !== after.metric.target ||
      before.metric.direction !== after.metric.direction)
  ) {
    await laneAuditRow(db, teamId, audit, 'lane.metric_changed', after.id, {
      lane: after.id,
      name: after.metric.name,
      from: { target: before.metric.target, direction: before.metric.direction },
      to: { target: after.metric.target, direction: after.metric.direction },
    });
  }
  const released = before.owner_seat !== null && after.state === 'open' && before.state !== 'open';
  if (released) {
    await laneAuditRow(db, teamId, audit, 'lane.released', after.id, {
      lane: after.id,
      released_by: audit.actor,
      owner_before: before.owner_seat,
      ...(edge.release_reason !== undefined ? { reason: edge.release_reason } : {}),
    });
  }
  const enteringAcceptance =
    isAwaitingAcceptance(after.state) && !isAwaitingAcceptance(before.state);
  if (
    after.state !== before.state &&
    !LANE_TERMINAL_STATES.has(after.state) &&
    !released &&
    // Local path: the origin PATCH handler owns `lane.ready_for_review` (routing + ask).
    // Hub-arbitrated path: that handler runs on the joiner AFTER the write, so nothing
    // foldable lands in the hub log unless we record the state move here (lane 01M2HNSVA79).
    // `audit.node` is the residence TRACE of a hub write (ADR 361) — absent on a local one.
    !(enteringAcceptance && audit.node === undefined) &&
    !claimed
  ) {
    await laneAuditRow(db, teamId, audit, 'lane.state_changed', after.id, {
      lane: after.id,
      from: before.state,
      to: after.state,
    });
  }
}

export async function openLane(
  db: Driver,
  teamId: string,
  teamSlug: string,
  createdBy: string,
  input: OpenLane,
  now: number = Date.now(),
): Promise<Lane> {
  const claim = input.claim === true;
  // The birth's actor IS the creator — every caller passed the same name twice, and two of three
  // (incidents, seeds) passed nothing and were born with no first event (dolly, #1179 decline). So
  // openLane takes no audit argument at all: the store writes the birth, and no caller can omit it.
  const audit: LaneAudit = { actor: createdBy };
  // ADR 645 §1–2: the declaration is refused where the anti-goal lives (a risk tag, user-facing,
  // high stakes), once, at open; the daemon stamps who declared it and when.
  const preRegistered = input.pre_registered
    ? { ...input.pre_registered, by: createdBy, at: now }
    : null;
  if (preRegistered) {
    const refusal = preRegisteredRefusal({ risk: input.risk, stakes: input.stakes });
    if (refusal) throw new MusterdError('bad_request', `${refusal} (ADR 645)`);
  }
  // ADR 673 §1: a metric is a dated read's — refused without `reads_on`; stamped like a verdict.
  const metric = input.metric ? metricRecord(input.metric, input.reads_on, createdBy, now) : null;
  // ADR 244: an admin's default-stakes rule fires HERE, at open, and never again. Resolving it late
  // — at submit, or at close — would make a policy able to rewrite what a lane already was, which is
  // the exact trap ADR 234 increment 2 named for the close edge: only a RECORDED fact earns a label.
  // An explicit declaration always wins, in EITHER direction: a seat that thinks its web change
  // deserves eyes must be able to say so without an admin, and a seat that says `low` on a lane
  // policy would have left `normal` has still declared it themselves.
  const surfaces = input.scope ?? [];
  const rule =
    input.stakes === undefined
      ? resolveStakesDefault((await getPolicy(db, teamId)).stakes_defaults, surfaces)
      : undefined;
  const stakes = input.stakes ?? rule?.stakes ?? 'normal';
  const declaredAreas = normalizeDeclaredAreas(input.areas);
  const requested = await resolveRequested(db, teamId, createdBy, input.requested);
  const row: LaneRow = {
    id: ulid(),
    team_id: teamId,
    project: input.project ?? 'default',
    title: input.title,
    detail: input.detail ?? null,
    kind: input.kind ?? null,
    owner_seat: claim ? createdBy : null,
    role: input.role ?? null,
    surface_globs: JSON.stringify(input.scope ?? []),
    depends_on: JSON.stringify(input.depends_on ?? []),
    branch: input.branch ?? null,
    goal_id: input.goal_id ?? null,
    risk: input.risk && input.risk.length > 0 ? JSON.stringify(input.risk) : null,
    // Store only an explicit non-default declaration; null means "did not say", which reads back as
    // 'normal'. Keeps "never declared" and "declared normal" indistinguishable ON PURPOSE — nothing
    // in increment 1 should be able to tell them apart, because nothing should act on the difference.
    stakes: stakes !== 'normal' ? stakes : null,
    // Written only where a policy actually fired. `declared` is the default on read, so a policy
    // that defaulted a lane to `normal` still records `defaulted` — the Eval must be able to see a
    // rule that fired even when it changed nothing, or "policy is inert here" becomes unfalsifiable.
    stakes_provenance: rule ? 'defaulted' : null,
    merged_json: null,
    parked_json: null,
    follows_up_json: null,
    abandon_reason: null,
    unfinished_todos_json: null,
    claims_json: null,
    areas_json: declaredAreas ? JSON.stringify(declaredAreas) : null,
    declined_json: null,
    source_ref: input.source_ref ?? null,
    requested_json: requestedRecordJson(requested),
    reads_on: input.reads_on ?? null,
    read_verdict_json: null,
    pre_registered_json: preRegistered ? JSON.stringify(preRegistered) : null,
    metric_json: metric ? JSON.stringify(metric) : null,
    card_json: null,
    state: claim ? 'claimed' : 'open',
    created_by: createdBy,
    created_at: now,
    claimed_at: claim ? now : null,
    resolved_at: null,
    updated_at: now,
  };
  const INSERT = `INSERT INTO lanes (id, team_id, project, title, detail, kind, owner_seat, role, surface_globs, depends_on, branch, goal_id, risk, stakes, stakes_provenance, merged_json, areas_json, source_ref, requested_json, reads_on, pre_registered_json, metric_json, card_json, state, created_by, created_at, claimed_at, resolved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  let card: LaneCard | null = null;
  await db.tx(async (t) => {
    if (row.source_ref !== null) await refuseHeldSourceRef(t, teamId, row.source_ref, row.id);
    // ADR 751: a new lane's card goes up in the emptiest part of its cell, put there by its opener.
    card = await placeCard(t, teamId, row.id, row.goal_id, row.state, createdBy, now);
    row.card_json = JSON.stringify(card);
    await t.run(INSERT, [
      row.id,
      row.team_id,
      row.project,
      row.title,
      row.detail,
      row.kind,
      row.owner_seat,
      row.role,
      row.surface_globs,
      row.depends_on,
      row.branch,
      row.goal_id,
      row.risk,
      row.stakes,
      row.stakes_provenance,
      row.merged_json,
      row.areas_json,
      row.source_ref,
      row.requested_json,
      row.reads_on,
      row.pre_registered_json,
      row.metric_json,
      row.card_json,
      row.state,
      row.created_by,
      row.created_at,
      row.claimed_at,
      row.resolved_at,
      row.updated_at,
    ]);
    // Finding 4 (lane-replication spec): the birth is the first event, and it carries the whole
    // declaration — the fields `lane.updated` will later diff against. Without it the log describes
    // what happened to a lane and never what the lane is.
    await laneAuditRow(t, teamId, audit, 'lane.opened', row.id, {
      lane: row.id,
      title: row.title,
      project: row.project,
      detail: row.detail,
      kind: row.kind,
      role: row.role,
      scope: input.scope ?? [],
      ...(declaredAreas ? { declared_areas: declaredAreas } : {}),
      depends_on: input.depends_on ?? [],
      branch: row.branch,
      goal_id: row.goal_id,
      risk: input.risk ?? [],
      stakes,
      stakes_provenance: row.stakes_provenance ?? 'declared',
      ...(row.source_ref !== null ? { source_ref: row.source_ref } : {}),
      ...(requested ? { requested } : {}),
      ...(row.reads_on !== null ? { reads_on: row.reads_on } : {}),
      ...(preRegistered ? { pre_registered: preRegistered } : {}),
      ...(metric ? { metric } : {}),
      ...(card ? { card } : {}),
      created_by: createdBy,
      created_at: now,
    });
    // A lane born owned is the most common acquisition of all (ADR 203). No collision is possible —
    // the lane did not exist — so no guard: just the row, `at_open` so a reader can tell a birth
    // from a takeover.
    if (row.owner_seat) {
      await laneAuditRow(t, teamId, audit, 'lane.claimed', row.id, {
        lane: row.id,
        owner: row.owner_seat,
        previous_owner: null,
        kind: 'claim',
        at_open: true,
      });
    }
    // ADR 710: heal in-flight lanes still carrying a name this checkout was known by before its
    // origin remote won (ADR 695). Same transaction: the new lane and the healed ones are one
    // project before anything reads the board.
    await healProjectAliases(t, teamId, audit, row.project, input.project_aliases ?? []);
  });
  return rowToLane(row, teamSlug);
}

/**
 * ADR 710 — a project rename heals its in-flight lanes. A repo whose folder name differs from its
 * origin remote's repo name derives the remote name (ADR 695). Lanes opened before that checkout
 * upgraded still carry the folder name, and contention is checked within one project string (ADR
 * 083), so the two generations would never overlap-warn or hold against each other — the silent
 * no-contention failure ADR 695 set out to fix, inverted and team-wide. The opener reports the
 * folder name as an alias; every NON-terminal lane carrying it moves to the derived name.
 *
 * Closed lanes keep their stored project, so ADR 695's "historical lanes are not rewritten" stays
 * true for history. The move is audited as a `lane.updated` project change, not a silent UPDATE:
 * a peer folding the log must see the same project a local reader does. `updated_at` deliberately
 * does not move — a rename is a label change, and awaiting lanes derive their wait age from it.
 */
async function healProjectAliases(
  t: Driver,
  teamId: string,
  audit: LaneAudit,
  project: string,
  aliases: string[],
): Promise<void> {
  const healed = [...new Set(aliases)].filter((a) => a !== project);
  if (healed.length === 0) return;
  const marks = healed.map(() => '?').join(', ');
  const rows = await t.all<{ id: string; project: string }>(
    `SELECT id, project FROM lanes
      WHERE team_id = ? AND project IN (${marks}) AND state NOT IN ('done','abandoned')`,
    [teamId, ...healed],
  );
  for (const lane of rows) {
    await t.run('UPDATE lanes SET project = ? WHERE team_id = ? AND id = ?', [
      project,
      teamId,
      lane.id,
    ]);
    await laneAuditRow(t, teamId, audit, 'lane.updated', lane.id, {
      lane: lane.id,
      fields: ['project'],
      changes: { project: { from: lane.project, to: project } },
    });
  }
}

/**
 * The lanes, other than `exceptId`, whose standing attestation names `sha` (lane 01M2GR0434). A
 * squash SHA belongs to one branch, so a second lane carrying it is either the same seat closing
 * twin lanes with one PR — nine of ten cases on the live db, 2026-09-14 — or a seat stamping its
 * lane with someone else's merge, the tenth. `decideLanePatch` tells them apart by owner.
 * `json_extract` on `merged_json`, which the store alone writes as JSON, so ADR 173's malformed-detail
 * hazard does not apply.
 */
export async function lanesAttestedBy(
  db: Driver,
  teamId: string,
  teamSlug: string,
  sha: string,
  exceptId: string,
): Promise<Lane[]> {
  return (
    await db.all<LaneRow>(
      `SELECT * FROM lanes WHERE team_id = ? AND id != ? AND merged_json IS NOT NULL
         AND json_extract(merged_json, '$.sha') = ? ORDER BY created_at`,
      [teamId, exceptId, sha],
    )
  ).map((r) => rowToLane(r, teamSlug));
}

export async function getLane(
  db: Driver,
  teamId: string,
  id: string,
  teamSlug: string,
): Promise<Lane | null> {
  const row = await db.get<LaneRow>('SELECT * FROM lanes WHERE team_id = ? AND id = ?', [
    teamId,
    id,
  ]);
  if (!row) return null;
  const lane = rowToLane(row, teamSlug);
  return lane.metric ? (await withSamples(db, teamId, [lane]))[0]! : lane;
}

/**
 * A title that is nothing but a full lane id (26 characters). `lane open <id>` typed where
 * `lane claim <id>` was meant opens an empty lane named after another one — twice in half an hour on
 * 2026-10-15. Full ids only, unlike a prefix: an 8-character rule would refuse a title that is a
 * date or a short word. `POST /lanes` refuses such a title (http.ts).
 */
export function isBareLaneId(title: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(title.trim());
}

/** ADR 582 §2: the shortest prefix that names a lane. A ULID's first 10 characters are its millisecond
 *  timestamp; 8 still separates lanes opened a second apart, and refusing shorter keeps a typo from
 *  landing on whichever lane happens to share two characters. */
export const LANE_ID_PREFIX_MIN = 8;

export type LaneRefResolution =
  | { kind: 'found'; id: string }
  | { kind: 'none' }
  | { kind: 'too_short' }
  | { kind: 'ambiguous'; candidates: { id: string; title: string }[] };

/**
 * Resolve what a seat typed to one lane id (ADR 582 §2). A full id is returned as it is; a unique
 * prefix of at least {@link LANE_ID_PREFIX_MIN} characters resolves to its lane; two or more matches
 * are refused with every candidate named, never guessed. Seats type what acts, `report` and the
 * launcher print — the 10-character form — so `lane_claim 01M4VA7NQG` said `no lane` until this
 * (2026-10-13). For the request boundary only: callers holding a stored id use {@link getLane}.
 */
export async function resolveLaneRef(
  db: Driver,
  teamId: string,
  ref: string,
): Promise<LaneRefResolution> {
  const exact = await db.get<{ id: string }>('SELECT id FROM lanes WHERE team_id = ? AND id = ?', [
    teamId,
    ref,
  ]);
  if (exact) return { kind: 'found', id: exact.id };
  // Only a ULID-shaped ref is a prefix query: no wildcard or quote ever reaches the comparison.
  const prefix = ref.toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]+$/.test(prefix) || prefix.length > 26) return { kind: 'none' };
  if (prefix.length < LANE_ID_PREFIX_MIN) return { kind: 'too_short' };
  const rows = await db.all<{ id: string; title: string }>(
    'SELECT id, title FROM lanes WHERE team_id = ? AND substr(id, 1, ?) = ? ORDER BY id LIMIT 6',
    [teamId, prefix.length, prefix],
  );
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'found', id: rows[0]!.id };
  return { kind: 'ambiguous', candidates: rows };
}

/**
 * The caller's expectation about a lane at write time (ADR 325 prereq). A claim decision is made
 * against a read; the write refuses if the lane no longer matches, instead of blindly overwriting
 * whatever landed in between. `undefined` fields are unchecked; `owner_seat: null` means
 * "expected unowned".
 */
export interface LaneExpectation {
  owner_seat?: string | null;
  state?: string;
}

/** A guarded lane write found the lane changed since the caller's read (ADR 325 prereq). */
export class LaneConflictError extends Error {
  constructor(
    readonly laneId: string,
    readonly expected: LaneExpectation,
    readonly actual: { owner_seat: string | null; state: string },
  ) {
    super(
      `lane "${laneId}" changed since it was read — expected ` +
        `owner=${expected.owner_seat === undefined ? '(any)' : String(expected.owner_seat)}/` +
        `state=${expected.state ?? '(any)'}, found ` +
        `owner=${String(actual.owner_seat)}/state=${actual.state}`,
    );
    this.name = 'LaneConflictError';
  }
}

/**
 * ADR 561: the lane on this team, other than `exceptId`, that holds `ref` while neither done nor
 * abandoned. At most one, by the refusal below; re-sync reads it to find an issue's lane.
 */
export async function laneHoldingSourceRef(
  db: Driver,
  teamId: string,
  ref: string,
  exceptId?: string,
): Promise<{ id: string } | undefined> {
  return db.get<{ id: string }>(
    `SELECT id FROM lanes WHERE team_id = ? AND source_ref = ? AND state NOT IN ('done','abandoned')
       AND id <> ? ORDER BY created_at LIMIT 1`,
    [teamId, ref, exceptId ?? ''],
  );
}

/** The 409 for a second live lane on one ref (ADR 561), run inside the writing transaction. */
async function refuseHeldSourceRef(
  db: Driver,
  teamId: string,
  ref: string,
  exceptId: string,
): Promise<void> {
  const holder = await laneHoldingSourceRef(db, teamId, ref, exceptId);
  if (holder)
    throw new MusterdError('conflict', `source_ref "${ref}" already belongs to lane ${holder.id}`);
}

/**
 * Apply a partial update (lane_update / claim / handoff / resolve are all this seam). Stamps
 * claimed_at on first ownership and resolved_at on done/abandoned. Returns null when unknown.
 *
 * The read, the decision, and the write run inside one transaction, the UPDATE assigns only the
 * columns that actually change, and an `expect` makes the write a guarded CAS — three ADR 325
 * prerequisites, each also correct under today's single daemon (a future `await` between a
 * caller's read and this write must not silently reintroduce the blind overwrite).
 */
/**
 * ADR 751: a card for `laneId` in the cell (`goalId` × the column of `state`), at the spot the
 * picker chooses among the cell's other cards; null when the state is off the board.
 */
async function placeCard(
  db: Driver,
  teamId: string,
  laneId: string,
  goalId: string | null,
  state: string,
  by: string,
  now: number,
): Promise<LaneCard | null> {
  const column = laneCardColumn(state);
  if (column === null) return null;
  const states =
    column === 'awaiting_acceptance' ? ['awaiting_acceptance', 'ready_for_review'] : [column];
  const rows = await db.all<{ card_json: string }>(
    `SELECT card_json FROM lanes
      WHERE team_id = ? AND id <> ? AND card_json IS NOT NULL
        AND state IN (${states.map(() => '?').join(', ')})
        AND ${goalId === null ? 'goal_id IS NULL' : 'goal_id = ?'}`,
    [teamId, laneId, ...states, ...(goalId === null ? [] : [goalId])],
  );
  const others = rows.map((r) => JSON.parse(r.card_json) as LaneCard);
  return { ...pickCardPlace(laneId, others), by, at: now };
}

export async function updateLane(
  db: Driver,
  teamId: string,
  id: string,
  teamSlug: string,
  patch: UpdateLane,
  now: number = Date.now(),
  expect?: LaneExpectation,
  audit?: LaneAudit,
): Promise<Lane | null> {
  return db.tx((t) => updateLaneInTx(t, teamId, id, teamSlug, patch, now, expect, audit));
}

async function updateLaneInTx(
  db: Driver,
  teamId: string,
  id: string,
  teamSlug: string,
  patch: UpdateLane,
  now: number,
  expect?: LaneExpectation,
  audit?: LaneAudit,
): Promise<Lane | null> {
  const existing = await getLane(db, teamId, id, teamSlug);
  if (!existing) return null;
  if (expect) {
    const ownerMismatch =
      expect.owner_seat !== undefined && existing.owner_seat !== expect.owner_seat;
    const stateMismatch = expect.state !== undefined && existing.state !== expect.state;
    if (ownerMismatch || stateMismatch) {
      throw new LaneConflictError(id, expect, {
        owner_seat: existing.owner_seat,
        state: existing.state,
      });
    }
  }
  const owned = patch.owner_seat !== undefined ? patch.owner_seat : existing.owner_seat;
  // Taking ownership of an `open` lane implies `claimed` unless the patch names a state itself.
  let state: LaneState =
    patch.state ??
    (patch.owner_seat !== undefined && existing.state === 'open' ? 'claimed' : existing.state);
  // ADR 192: coerce the legacy ADR 169 spelling on write so new rows are canonical.
  if (state === 'ready_for_review') state = 'awaiting_acceptance';
  // The release invariant: `open` means unowned, so moving a lane back to `open` lets go of it —
  // owner and the claim stamp both clear. Without this the state machine admits (open, owner=X),
  // and the board then states a false fact: a lane nobody is working, rendered as someone's. This
  // transition *is* the release verb (no `owner_seat: null` on the patch surface — that would also
  // let a caller assign an arbitrary owner, which lane_claim is for).
  // ADR 466: `parked` is unowned too — shelved work is nobody's work in progress, so parking a
  // claimed lane releases it exactly as the move to `open` does.
  const ownerSeat = state === 'open' || state === 'parked' ? null : owned;
  // The park record rides the state: written on the move in (from the patch; the transport has
  // already required a reason), kept while it stays parked, cleared on any move out.
  const parked =
    state !== 'parked'
      ? null
      : existing.state === 'parked' && existing.parked
        ? existing.parked
        : {
            by: audit?.actor ?? 'unknown',
            at: now,
            reason: patch.park_reason ?? '',
            ...(patch.park_until !== undefined ? { until: patch.park_until } : {}),
          };
  // ADR 192: a merge attestation on a patch that *enters or sits in* awaiting_acceptance is the
  // worker's stage-one claim — persist it so a counterpart's later accept carries it. A worker's
  // own terminal patch may still rewrite it (ADR 109). A counterpart terminal patch must not:
  // the HTTP layer strips `merged` before this write (ADR 305), because MCP/CLI resolve send a
  // partial object and wholesale replace dropped `authorized_by` and the ADR 300 verification tier.
  const merged = patch.merged !== undefined ? patch.merged : existing.merged;
  // ADR 487: the close's answer is kept once given; a later answer (a re-submit) replaces it.
  const followsUp =
    patch.follows_up !== undefined ? patch.follows_up : (existing.follows_up ?? null);
  // The drop reason rides `abandoned` the way the park record rides `parked`: set by the patch on or
  // after the move in, kept while it stays abandoned, cleared if the lane is ever reopened.
  const abandonReason =
    state !== 'abandoned' ? null : (patch.abandon_reason ?? existing.abandon_reason ?? null);
  // ADR 487 §5.2: the hook sends the whole list (last write wins); an empty one clears it. Kept on
  // a closed lane, so the acceptor and the weekly sweep can still read what was left.
  const todos =
    patch.unfinished_todos === undefined
      ? (existing.unfinished_todos ?? null)
      : patch.unfinished_todos.length === 0
        ? null
        : { items: patch.unfinished_todos, at: now };
  // ADR 585: a checker's fresh claims merge into the standing list — its own earlier reading of a
  // (kind, ref) is replaced, other seats' readings stay — so an acceptor's re-check sits beside the
  // submitter's, never over it. `checked_by` was stamped by the transport from the authenticated
  // sender before this write; the store trusts the patch it is handed.
  // Merged against the full stored list, never the served (capped) view (lane 01M5ZFZBCD).
  const stored = await storedClaims(db, teamId, id);
  const claims =
    patch.claims !== undefined
      ? mergeClaims(stored, patch.claims)
      : stored.length > 0
        ? stored
        : null;
  const declaredAreas =
    patch.areas !== undefined
      ? normalizeDeclaredAreas(patch.areas)
      : (existing.declared_areas ?? null);
  // ADR 624: a release that says why becomes the lane's decline note, which the lane picker shows the
  // next time anyone opens it; any claim clears it, so the note never sits on a lane someone owns.
  // A release without a reason, and every other edit, leaves the standing note as it was.
  const releasing = ownerSeat === null && existing.owner_seat !== null && state === 'open';
  const declined =
    releasing && patch.release_reason !== undefined
      ? { by: audit?.actor ?? 'unknown', reason: patch.release_reason, at: now }
      : ownerSeat !== null && ownerSeat !== existing.owner_seat
        ? null
        : (existing.declined ?? null);
  // ADR 629: fill a missing requester. A different record on a lane that already has one is a 409;
  // the same value again is a no-op so a retry succeeds. Omitted leaves whatever is stored.
  let requestedJson = requestedRecordJson(existing.requested);
  if (patch.requested !== undefined) {
    const actor = audit?.actor;
    if (!actor)
      throw new MusterdError('bad_request', 'recording who asked needs the seat doing it');
    const settled = await resolveRequested(db, teamId, actor, patch.requested);
    if (settled) {
      const nextJson = requestedRecordJson(settled);
      if (requestedJson !== null && requestedJson !== nextJson)
        throw new MusterdError('conflict', 'who asked is already recorded on this lane');
      requestedJson = nextJson;
    }
  }
  // ADR 644: the read date is a declared field (`null` clears it); the verdict is stamped here from
  // the authenticated sender and this clock, so a stored verdict always says who gave it and when.
  // A later verdict replaces an earlier one.
  const readsOn = patch.reads_on !== undefined ? patch.reads_on : (existing.reads_on ?? null);
  let readVerdict = existing.read_verdict ?? null;
  if (patch.read_verdict !== undefined) {
    if (readsOn === null)
      throw new MusterdError(
        'bad_request',
        `read_verdict answers a read, and lane "${id}" has no reads_on — declare the day first ` +
          `(lane_update {reads_on: 'YYYY-MM-DD'})`,
      );
    const actor = audit?.actor;
    if (!actor)
      throw new MusterdError('bad_request', 'recording a read verdict needs the seat doing it');
    readVerdict = { ...patch.read_verdict, by: actor, at: now };
  }
  // ADR 673 §1: set, replace or clear (`null`) the metric. It needs a read day, so clearing
  // `reads_on` under a standing metric is refused unless the same patch clears the metric too.
  let metric = existing.metric ?? null;
  if (patch.metric !== undefined) {
    if (patch.metric === null) metric = null;
    else {
      const actor = audit?.actor;
      if (!actor) throw new MusterdError('bad_request', 'setting a metric needs the seat doing it');
      metric = metricRecord(patch.metric, readsOn, actor, now);
    }
  } else if (metric !== null && readsOn === null)
    throw new MusterdError(
      'bad_request',
      `lane "${id}" measures ${metric.name}: clear the metric (metric: null) before reads_on (ADR 673)`,
    );
  // ADR 673 §3: on a metric lane, met / missed carries the number it was decided by.
  if (
    patch.read_verdict !== undefined &&
    metric !== null &&
    patch.read_verdict.outcome !== 'inconclusive' &&
    patch.read_verdict.measured === undefined
  )
    throw new MusterdError(
      'bad_request',
      `this lane measures ${metric.name}: give measured {value, n} with ${patch.read_verdict.outcome} (ADR 673)`,
    );
  // ADR 645 §1–2: `null` withdraws the declaration; an object replaces it, stamped from the
  // authenticated sender. Refused on a lane that is not open (409 — a declaration is made before
  // the work) and where the anti-goal lives (400 — the resulting risk / stakes), so a patch that
  // tags a declared lane risky or high-stakes is refused too: the invariant holds in both orders.
  let preRegistered = existing.pre_registered ?? null;
  if (patch.pre_registered !== undefined) {
    if (patch.pre_registered === null) preRegistered = null;
    else {
      if (existing.state !== 'open')
        throw new MusterdError(
          'conflict',
          `lane "${id}" is ${existing.state} — a pre-registered declaration is made on an open ` +
            `lane, before the work (ADR 645)`,
        );
      const actor = audit?.actor;
      if (!actor)
        throw new MusterdError(
          'bad_request',
          'declaring a lane pre-registered needs the seat doing it',
        );
      preRegistered = { ...patch.pre_registered, by: actor, at: now };
    }
  }
  if (preRegistered) {
    const refusal = preRegisteredRefusal({
      risk: patch.risk ?? existing.risk,
      stakes: patch.stakes ?? existing.stakes,
    });
    if (refusal) throw new MusterdError('bad_request', `${refusal} (ADR 645)`);
  }
  const risk = patch.risk ?? existing.risk;
  const stakes = patch.stakes ?? existing.stakes;
  // ADR 244: editing stakes takes OWNERSHIP of the value. A worker overriding a policy-defaulted
  // lane has made their own judgement, and leaving it `defaulted` would keep counting that lane
  // toward the very policy it was overriding — inflating the policy bucket with its own refutations.
  // Untouched otherwise, so a patch to some other field never launders provenance.
  const stakesProvenance = patch.stakes !== undefined ? 'declared' : existing.stakes_provenance;
  // ADR 751: the card follows its cell. Off the board (parked, abandoned) it is gone; a named place
  // wins; a new cell, or a lane that never had a card, gets the emptiest spot in its cell.
  const goalId = patch.goal_id !== undefined ? patch.goal_id : existing.goal_id;
  const column = laneCardColumn(state);
  const movedCell =
    column !== laneCardColumn(existing.state) || goalId !== existing.goal_id || !existing.card;
  if (patch.card && column === null)
    throw new MusterdError(
      'bad_request',
      `lane ${id} is ${state}, so it has no card on the board to place (ADR 751)`,
    );
  const card: LaneCard | null =
    column === null
      ? null
      : patch.card
        ? { x: patch.card.x, y: patch.card.y, by: audit?.actor ?? 'unknown', at: now }
        : movedCell
          ? await placeCard(db, teamId, id, goalId, state, audit?.actor ?? 'unknown', now)
          : (existing.card ?? null);
  const next = {
    id,
    team_id: teamId,
    project: patch.project ?? existing.project,
    // ADR 240: the title is correctable — opt-in, like `detail`, so every other patch leaves it be.
    title: patch.title !== undefined ? patch.title : existing.title,
    detail: patch.detail !== undefined ? patch.detail : existing.detail,
    owner_seat: ownerSeat,
    surface_globs: JSON.stringify(patch.scope ?? existing.scope),
    depends_on: JSON.stringify(patch.depends_on ?? existing.depends_on),
    branch: patch.branch !== undefined ? patch.branch : existing.branch,
    goal_id: goalId,
    risk: risk.length > 0 ? JSON.stringify(risk) : null,
    stakes: stakes !== 'normal' ? stakes : null,
    stakes_provenance: stakesProvenance,
    merged_json: merged ? JSON.stringify(merged) : null,
    parked_json: parked ? JSON.stringify(parked) : null,
    follows_up_json: followsUp !== null ? JSON.stringify(followsUp) : null,
    claims_json: claims && claims.length > 0 ? JSON.stringify(claims) : null,
    areas_json: declaredAreas ? JSON.stringify(declaredAreas) : null,
    abandon_reason: abandonReason,
    unfinished_todos_json: todos !== null ? JSON.stringify(todos) : null,
    declined_json: declined !== null ? JSON.stringify(declined) : null,
    source_ref: patch.source_ref !== undefined ? patch.source_ref : (existing.source_ref ?? null),
    requested_json: requestedJson,
    reads_on: readsOn,
    read_verdict_json: readVerdict !== null ? JSON.stringify(readVerdict) : null,
    pre_registered_json: preRegistered !== null ? JSON.stringify(preRegistered) : null,
    metric_json: metric !== null ? JSON.stringify(metric) : null,
    card_json: card !== null ? JSON.stringify(card) : null,
    state,
    // claimed_at describes the CURRENT tenure: sticky while held, cleared by the release above so a
    // re-claim stamps fresh rather than inheriting the previous holder's timestamp.
    //
    // "Cleared by the release above" only covers owner -> open -> owner. A DIRECT owner -> owner
    // move (a handoff, or the takeover this used to permit) never passes through null, so the new
    // holder inherited the old one's stamp — and the field that should have read "owned since
    // 22:00" instead read as the new holder's own claim. That is not cosmetic: it is precisely what
    // let a takeover be misread as a first claim on 2026-08-01. A new owner always starts a new
    // tenure, so stamp fresh whenever the owner actually changes.
    claimed_at:
      ownerSeat === null
        ? null
        : ownerSeat !== existing.owner_seat
          ? now
          : (existing.claimed_at ?? now),
    resolved_at: LANE_TERMINAL_STATES.has(state as LaneState)
      ? (existing.resolved_at ?? now)
      : null,
    updated_at: now,
  };
  // Per-field write (ADR 325 prereq): assign only the columns that actually change, so a patch's
  // blast radius is its own fields — never a blind LWW of the whole row. Diffed against the raw
  // row, not the parsed Lane, so JSON-serialization round-trips cannot fake a change.
  const rawRow = (await db.get<LaneRow>('SELECT * FROM lanes WHERE team_id = ? AND id = ?', [
    teamId,
    id,
  ]))!;
  // ADR 561: one lane that is neither done nor abandoned per ref. Checked when this write would make
  // the lane such a holder — a new ref, or a closed lane carrying one moving back to a live state.
  if (
    next.source_ref !== null &&
    !LANE_TERMINAL_STATES.has(state) &&
    (next.source_ref !== rawRow.source_ref || LANE_TERMINAL_STATES.has(existing.state))
  )
    await refuseHeldSourceRef(db, teamId, next.source_ref, id);
  const columns = [
    'project',
    'title',
    'detail',
    'owner_seat',
    'surface_globs',
    'depends_on',
    'branch',
    'goal_id',
    'risk',
    'stakes',
    'stakes_provenance',
    'merged_json',
    'parked_json',
    'follows_up_json',
    'abandon_reason',
    'unfinished_todos_json',
    'source_ref',
    'requested_json',
    'reads_on',
    'read_verdict_json',
    'pre_registered_json',
    'metric_json',
    'card_json',
    'claims_json',
    'areas_json',
    'declined_json',
    'state',
    'claimed_at',
    'resolved_at',
  ] as const;
  const changed = columns.filter((c) => next[c] !== rawRow[c]);
  await db.run(
    `UPDATE lanes SET ${[...changed.map((c) => `${c}=?`), 'updated_at=?'].join(', ')}
     WHERE team_id=? AND id=?`,
    [...changed.map((c) => next[c]), now, teamId, id],
  );
  const after = (await getLane(db, teamId, id, teamSlug))!;
  if (audit)
    await recordLaneEdges(db, teamId, existing, after, patch.owner_seat !== undefined, audit, {
      pick: patch.pick,
      release_reason: patch.release_reason,
      read_verdict_written: patch.read_verdict !== undefined,
    });
  // ADR 487 §5.1: a named follow-up with no goal joins this lane's goal, in the same transaction —
  // so the local path and the hub's arbitration both attach it, and a refused write attaches
  // nothing. One already on a goal keeps it. The policy (`decideFollowsUp`) has already refused a
  // list whose goalless lanes would have nowhere to go.
  if (Array.isArray(patch.follows_up) && after.goal_id !== null) {
    for (const nextId of patch.follows_up) {
      if (nextId === id) continue;
      const named = await getLane(db, teamId, nextId, teamSlug);
      if (named && named.goal_id === null)
        await updateLaneInTx(
          db,
          teamId,
          nextId,
          teamSlug,
          { goal_id: after.goal_id },
          now,
          undefined,
          audit,
        );
    }
  }
  return after;
}

/** Fields a `lane.updated` audit row reports (ADR 325 prereq). Ownership and state are excluded —
 *  those edges have their own audit verbs — as are derived stamps (claimed_at &c.). */
export const AUDITED_LANE_FIELDS = [
  'project',
  'title',
  'detail',
  'branch',
  'goal_id',
  'scope',
  'declared_areas',
  'depends_on',
  'risk',
  'stakes',
  'merged',
  'parked',
  'follows_up',
  'abandon_reason',
  'unfinished_todos',
  'source_ref',
  'declined',
  'requested',
  'reads_on',
  'read_verdict',
  'pre_registered',
  'metric',
  'card',
] as const;

/** Which auditable fields differ between two reads of a lane (arrays/objects by value). */
export function laneFieldChanges(before: Lane, after: Lane): string[] {
  return AUDITED_LANE_FIELDS.filter(
    (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
  );
}

/**
 * The values behind `laneFieldChanges`: `{ field: { from, to } }` for every audited field that
 * moved. `lane.updated` carried names only, so history could prove a scope changed and never say
 * to what — a replicating peer folding the row had nothing to apply (lane-replication spec
 * §Finding 3, hole 2). Absent reads as `null` on both sides, matching the equality above.
 */
export function laneFieldDiff(
  before: Lane,
  after: Lane,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of laneFieldChanges(before, after)) {
    const key = f as (typeof AUDITED_LANE_FIELDS)[number];
    out[f] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return out;
}

/**
 * ADR 644 §3: a lane that declares `reads_on` cannot close `done` while no read has a verdict —
 * the same posture as ADR 487's `follows_up`: silence is the only shape refused. `abandoned` is
 * unaffected (an abandoned read is `dropped`, not overdue). The verdict may ride this same patch,
 * and a patch that clears `reads_on` also lifts the refusal. Shared by the local and hub paths.
 */
export function decideReadVerdict(before: Lane, body: UpdateLane): void {
  if (body.state !== 'done' || LANE_TERMINAL_STATES.has(before.state)) return;
  const readsOn = body.reads_on !== undefined ? body.reads_on : (before.reads_on ?? null);
  if (readsOn === null) return;
  if (body.read_verdict !== undefined || before.read_verdict) return;
  throw new MusterdError(
    'validation',
    `lane "${before.id}" reads on ${readsOn}: give read_verdict (outcome met|missed|inconclusive ` +
      `and a note of what was read) before closing it done (ADR 644). CLI: --read-verdict ` +
      `<outcome> --read-note "<what was read>". An older adapter has no such field — rebuild ` +
      `(pnpm build) and reload.`,
  );
}

export interface LaneFilter {
  project?: string;
  owner?: string;
  openOnly?: boolean;
  goalId?: string;
  /**
   * Only lanes in these states. The board reader for a seat with history: `mine` alone
   * returns every lane ever owned (200 done rows bury the live ones), so the reader needs a
   * state edge — `GET /lanes?state=claimed&state=active`, `lane_board {state: [...]}`.
   */
  states?: LaneState[];
  /** Only lanes of this kind (`incident` — the daemon-opened shared-blocker lane). */
  kind?: NonNullable<Lane['kind']>;
  /** Only lanes carrying this exact `source_ref` (ADR 561), in any state. */
  sourceRef?: string;
}

export async function listLanes(
  db: Driver,
  teamId: string,
  teamSlug: string,
  filter: LaneFilter = {},
): Promise<Lane[]> {
  // The filter is the WHERE, not a pass over every row: the reaper's per-team reads shipped a
  // 1,376-lane team's whole board every 15 s to keep the few in one state (lane 01M497KVXS).
  if (filter.states?.length === 0) return [];
  const where = ['team_id = ?'];
  const params: unknown[] = [teamId];
  const eq = (column: string, value: string | undefined) => {
    if (!value) return;
    where.push(`${column} = ?`);
    params.push(value);
  };
  eq('project', filter.project);
  eq('owner_seat', filter.owner);
  eq('state', filter.openOnly ? 'open' : undefined);
  eq('goal_id', filter.goalId);
  eq('kind', filter.kind);
  eq('source_ref', filter.sourceRef);
  if (filter.states) {
    where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
    params.push(...filter.states);
  }
  const rows = await db.all<LaneRow>(
    `SELECT * FROM lanes WHERE ${where.join(' AND ')} ORDER BY created_at`,
    params,
  );
  // ADR 673: a metric lane carries its newest samples — one query for the board, none without one.
  return withSamples(
    db,
    teamId,
    rows.map((r) => rowToLane(r, teamSlug)),
  );
}

/**
 * ADR 544: the hub's lanes older than its replicated history (`id < beforeId`; ULIDs sort by birth),
 * in their current state — what a joiner can never learn from the log. Ordered by id so a page is
 * stable; the count beside it is what a pull page carries so a joiner knows whether to ask.
 */
export async function listLanesBefore(
  db: Driver,
  teamId: string,
  teamSlug: string,
  beforeId: string,
): Promise<Lane[]> {
  const rows = await db.all<LaneRow>(
    'SELECT * FROM lanes WHERE team_id = ? AND id < ? ORDER BY id',
    [teamId, beforeId],
  );
  return rows.map((r) => rowToLane(r, teamSlug));
}

export async function countLanesBefore(
  db: Driver,
  teamId: string,
  beforeId: string,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM lanes WHERE team_id = ? AND id < ?',
    [teamId, beforeId],
  );
  return Number(row?.n ?? 0);
}

/**
 * ADR 544: a joiner adopts one of the hub's pre-genesis lanes — the whole row as the hub holds it
 * now, inserted only if this daemon has no row for the id. Never an update: a row this daemon holds
 * is already converging through the fold, and a snapshot must not race it. Returns whether a row
 * was written.
 */
export async function insertLaneSnapshot(db: Driver, teamId: string, lane: Lane): Promise<boolean> {
  const r = await db.run(
    `INSERT INTO lanes (id, team_id, project, title, detail, kind, owner_seat, role, surface_globs, depends_on, branch, goal_id, risk, stakes, stakes_provenance, merged_json, parked_json, follows_up_json, abandon_reason, unfinished_todos_json, areas_json, declined_json, source_ref, requested_json, state, created_by, created_at, claimed_at, resolved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      lane.id,
      teamId,
      lane.project,
      lane.title,
      lane.detail,
      lane.kind ?? null,
      lane.owner_seat,
      lane.role,
      JSON.stringify(lane.scope),
      JSON.stringify(lane.depends_on),
      lane.branch,
      lane.goal_id,
      lane.risk.length > 0 ? JSON.stringify(lane.risk) : null,
      lane.stakes === 'normal' ? null : lane.stakes,
      lane.stakes_provenance === 'defaulted' ? 'defaulted' : null,
      lane.merged ? JSON.stringify(lane.merged) : null,
      lane.parked ? JSON.stringify(lane.parked) : null,
      lane.follows_up !== undefined ? JSON.stringify(lane.follows_up) : null,
      lane.abandon_reason ?? null,
      lane.unfinished_todos ? JSON.stringify(lane.unfinished_todos) : null,
      lane.declared_areas && lane.declared_areas.length > 0
        ? JSON.stringify(lane.declared_areas)
        : null,
      lane.declined ? JSON.stringify(lane.declined) : null,
      lane.source_ref ?? null,
      requestedRecordJson(lane.requested),
      lane.state,
      lane.created_by,
      lane.created_at,
      lane.claimed_at,
      lane.resolved_at,
      lane.updated_at,
    ],
  );
  return (r.changes ?? 0) > 0;
}

/**
 * The in-memory half of `listLanes`, so a caller that already holds the board (one read per
 * request — lane 01M3ANEQVR: `GET /lanes` used to read the 1218-row table 16 times, 116 ms of its
 * 267 ms) can derive a filtered view without going back to SQLite.
 */
export function filterLanes(lanes: Lane[], filter: LaneFilter = {}): Lane[] {
  return lanes
    .filter((l) => (filter.project ? l.project === filter.project : true))
    .filter((l) => (filter.owner ? l.owner_seat === filter.owner : true))
    .filter((l) => (filter.openOnly ? l.state === 'open' : true))
    .filter((l) => (filter.goalId ? l.goal_id === filter.goalId : true))
    .filter((l) => (filter.states ? filter.states.includes(l.state) : true))
    .filter((l) => (filter.kind ? l.kind === filter.kind : true))
    .filter((l) => (filter.sourceRef ? l.source_ref === filter.sourceRef : true));
}

/**
 * How far back `GET /lanes` reaches into closed work by default (ADR 534). The board grew one
 * done row per merged lane forever; 14 days covers the web board's Done column (10 newest), a
 * goal's recent shipped chips and a seat's just-closed lane, and `?history=all` restores the rest.
 */
export const LANE_HISTORY_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * Drop done/abandoned lanes that closed before the history window (ADR 534). A live lane is never
 * dropped, however old; a closed lane's age runs from `resolved_at`, falling back to `updated_at`
 * for a row closed before resolved_at was stamped.
 */
export function withinHistoryWindow(
  lanes: Lane[],
  now: number,
  windowMs = LANE_HISTORY_WINDOW_MS,
): Lane[] {
  const cutoff = now - windowMs;
  return lanes.filter(
    (l) => !LANE_TERMINAL_STATES.has(l.state) || (l.resolved_at ?? l.updated_at) >= cutoff,
  );
}

/**
 * What a lane-less `handoff` should carry (ADR 231).
 *
 * `attach` — the sender holds exactly one live lane, so there is nothing to choose between and the
 * daemon writes `meta.lane_handoff` onto the envelope. `ambiguous` — two or more, so the daemon
 * warns and stores the message untouched rather than mis-attributing it. `none` — the genuinely
 * lane-less handoff, which is legal and stays silent.
 */
export type HandoffLaneDerivation =
  | { kind: 'attach'; lane: Lane; basis: HandoffLaneBasis }
  | { kind: 'ambiguous'; candidates: Lane[]; basis: HandoffLaneBasis }
  | { kind: 'none' };

/**
 * Which evidence answered (ADR 243) — audited, never on the wire. `handed_to_recipient` is the
 * strong fact (this sender gave that seat this lane, and they still hold it); `held` is ADR 231's
 * original fallback. Recorded so the two rules can be told apart in a month: a derived population
 * still dominated by `held` means the fallback is doing the real work.
 */
export type HandoffLaneBasis = 'handed_to_recipient' | 'held';

/**
 * Derive the lane a `handoff` from `seat` is about, from the lanes that seat actually holds.
 *
 * Only `lane_handoff` ever wrote `meta.lane_handoff.lane`, so 24 of the first 30 handoffs on the
 * dogfood team named no lane at all — and the orientation `why`, which reads a handoff as a live
 * instruction, has nothing to check those against. It cannot tell a fresh instruction from a
 * four-day-old one whose PR merged, so it serves the stale one (ADR 173's abstain-by-showing: an
 * unjudgeable why is still the human's words, and hiding it is worse).
 *
 * This closes the gap by construction rather than by heuristic — the rejected alternative was to
 * age out an old handoff, which is a number standing in for a fact. Deliberately warn-not-refuse on
 * ambiguity: unlike the un-threaded `accept` (send.ts), where a wrong guess writes a verdict onto
 * the wrong lane and cannot be recovered, declining to attach here leaves the message exactly as it
 * is today — unjudgeable, but never wrong. A message is worth more than a derived field.
 *
 * ADR 243 CORRECTION. Held lanes are the WEAKER evidence and are now the fallback, because
 * `lane_handoff` transfers ownership *before* the explanatory act is sent: the lane the sender means
 * has already left the held set and could never be derived, while an unrelated lane they still hold
 * could — silently, in the confident single-candidate branch. The stronger fact is the pairing the
 * sender just created: `recipient` is who this act is directed at, so a lane this sender handed to
 * THAT seat, which that seat still holds, has an unambiguous referent that "a lane I hold" cannot
 * see. Preferred, not merged into one pool: a held lane must never dilute a handed one into a
 * false ambiguity, and a handed one must never be outvoted by lanes that have nothing to do with
 * this recipient.
 */
/**
 * Is there anything left to hand over in a lane in this state?
 *
 * Terminal is the obvious half. `awaiting_acceptance` is the half this used to miss (lane
 * 01M2KTBDNP, observed 2026-09-15): the work has LANDED there — the branch is merged, its remote is
 * deleted, and the only act still owed is somebody else's accept — so a handoff cannot be about it.
 * The old filter asked only "not terminal", so a submitted lane stayed a candidate and, for a seat
 * holding exactly one, was attached with confidence rather than reaching the deliberate
 * warn-and-attach-nothing path. That is not a display wart: on `attach` the route rewrites the
 * envelope's `meta.lane_handoff`, so the delivered act permanently names finished work, and ADR 243
 * exists so the orientation `why` can read that field and tell the recipient which work this is.
 *
 * Read through `isAwaitingAcceptance`, never by comparing against a name: `ready_for_review` is the
 * ADR 169 spelling still dual-accepted on the wire, and matching only the canonical one would leave
 * a skewed daemon's lanes derivable (lanes.wire.ts says exactly this).
 */
function hasWorkLeftToHandOver(state: LaneState): boolean {
  return !LANE_TERMINAL_STATES.has(state) && !isAwaitingAcceptance(state);
}

export async function deriveHandoffLane(
  db: Driver,
  teamId: string,
  teamSlug: string,
  seat: string,
  /** The seat this handoff act is directed at, when it is directed at one. */
  recipient?: string,
): Promise<HandoffLaneDerivation> {
  if (recipient !== undefined && recipient !== seat) {
    const handed = await lanesHandedTo(db, teamId, teamSlug, seat, recipient);
    const basis = 'handed_to_recipient' as const;
    if (handed.length === 1) return { kind: 'attach', lane: handed[0]!, basis };
    if (handed.length > 1) return { kind: 'ambiguous', candidates: handed, basis };
  }
  const held = (await listLanes(db, teamId, teamSlug, { owner: seat })).filter((l) =>
    hasWorkLeftToHandOver(l.state),
  );
  if (held.length === 0) return { kind: 'none' };
  if (held.length === 1) return { kind: 'attach', lane: held[0]!, basis: 'held' };
  return { kind: 'ambiguous', candidates: held, basis: 'held' };
}

/** How far back the handed-lane read scans the ledger. Ordered by ts DESC, so this is a page size
 *  and not a time window — the qualifying test is current ownership, never age. */
const HANDOFF_LEDGER_SCAN = 200;

/**
 * Lanes `sender` handed to `recipient` that `recipient` still holds and has not closed (ADR 243).
 *
 * Read from the acquisition ledger (ADR 203), which is the only record that distinguishes a handoff
 * from a self-claim — the lane row afterwards shows only who owns it, not who gave it to them. The
 * qualifying condition is deliberately **current state, not recency**: the recipient still owns it
 * and it is still live. An old transfer the recipient has since resolved, released or passed on is
 * gone from the set because the fact stopped being true, not because a timer expired it — the same
 * reason ADR 231 refused to age out an old handoff.
 *
 * `detail` is parsed in JS rather than filtered with `json_extract`, on ADR 173's evidence: a single
 * malformed `detail` makes SQLite raise from the QUERY and takes down every read that scans it.
 */
async function lanesHandedTo(
  db: Driver,
  teamId: string,
  teamSlug: string,
  sender: string,
  recipient: string,
): Promise<Lane[]> {
  const rows = await db.all<AuditRow>(
    `SELECT * FROM audit WHERE team_id = ? AND action = 'lane.claimed' AND actor = ?
       ORDER BY ts DESC, id DESC LIMIT ?`,
    [teamId, sender, HANDOFF_LEDGER_SCAN],
  );
  const handedIds = new Set<string>();
  for (const row of rows) {
    let detail: { kind?: unknown; owner?: unknown; lane?: unknown };
    try {
      detail = JSON.parse(row.detail ?? '{}') as typeof detail;
    } catch {
      continue; // an unreadable row is not evidence of anything; never let it break the read
    }
    if (detail.kind !== 'handoff' || detail.owner !== recipient) continue;
    const lane = typeof detail.lane === 'string' ? detail.lane : row.target;
    if (lane) handedIds.add(lane);
  }
  if (handedIds.size === 0) return [];
  return (await listLanes(db, teamId, teamSlug, { owner: recipient })).filter(
    (l) => handedIds.has(l.id) && hasWorkLeftToHandOver(l.state),
  );
}

/** Lanes joined to a Goal (ADR 084) — the input to {@link deriveGoalStatus}. */
export async function lanesForGoal(
  db: Driver,
  teamId: string,
  teamSlug: string,
  goalId: string,
): Promise<Lane[]> {
  return await listLanes(db, teamId, teamSlug, { goalId });
}

/** Lane states that are terminal — a lane no longer being worked (ADR 169: shared constant). */
const TERMINAL: ReadonlySet<string> = LANE_TERMINAL_STATES;

/**
 * The pinned derived-Goal-status rule (ADR 048 as amended by ADR 084): **lanes-authoritative,
 * conjunctive, flap-tolerant.** Given the lanes joined to a Goal:
 *   - `shipped`   ⟺ ≥1 lane, all terminal, and ≥1 reached `done` (not all `abandoned`);
 *   - `in-flight` ⟺ any lane is live (open/claimed/active/blocked/ready_for_review);
 *   - `planned`   ⟺ no lanes.
 * Threads never enter here — they are the fallback the caller uses only when a Goal has zero lanes,
 * so a dead thread-`resolve` (2/21 in practice) can never pin a Goal's status. Live, not a latch:
 * a new lane on a shipped Goal honestly returns it to `in-flight`.
 */
/**
 * Every goal-linked lane's state, grouped by goal — the one input {@link deriveGoalStatus} reads.
 * A narrow read on purpose (lane 01M3D4069F): hydrating the whole board (detail bodies, JSON
 * columns) for two columns made each `GET /report` ~20 ms slower at a 1200-lane board, and every
 * open /live viewer refetches the report on every lane act.
 */
export async function laneStatesByGoal(
  db: Driver,
  teamId: string,
): Promise<Map<string, Pick<Lane, 'state'>[]>> {
  const rows = await db.all<{ goal_id: string; state: LaneState }>(
    'SELECT goal_id, state FROM lanes WHERE team_id = ? AND goal_id IS NOT NULL',
    [teamId],
  );
  const byGoal = new Map<string, Pick<Lane, 'state'>[]>();
  for (const { goal_id, state } of rows) {
    const group = byGoal.get(goal_id);
    if (group) group.push({ state });
    else byGoal.set(goal_id, [{ state }]);
  }
  return byGoal;
}

/** The blocked lanes, board order — the report's exception list, without hydrating the board. */
export async function listBlockedLanes(
  db: Driver,
  teamId: string,
): Promise<Pick<Lane, 'id' | 'title' | 'owner_seat' | 'goal_id'>[]> {
  return await db.all<Pick<Lane, 'id' | 'title' | 'owner_seat' | 'goal_id'>>(
    `SELECT id, title, owner_seat, goal_id FROM lanes WHERE team_id = ? AND state = 'blocked' ORDER BY created_at`,
    [teamId],
  );
}

export function deriveGoalStatus(
  lanes: Pick<Lane, 'state'>[],
): 'planned' | 'in-flight' | 'shipped' {
  if (lanes.length === 0) return 'planned';
  const allTerminal = lanes.every((l) => TERMINAL.has(l.state));
  const anyDone = lanes.some((l) => l.state === 'done');
  if (allTerminal && anyDone) return 'shipped';
  return 'in-flight';
}

/**
 * Longest declared segment `globsOverlap` matches exactly. A longer one is assumed to overlap: the
 * check is warn-only, and the cap bounds the work one lane's declaration can cost every lane verb.
 */
const OVERLAP_SEGMENT_MAX = 256;

/**
 * One path segment against a pattern whose only wildcard is `*` (any run within the segment — `?`
 * and `[` are literal, as in `globToRegExp`'s path flavor). Greedy with one backtrack point, so it
 * is O(pattern × text) at worst: both sides are member-supplied, and a backtracking regex here let
 * one declared glob hold the event loop (security review of ADR 575, 2026-10-12).
 */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * A glob that contains `**` does not match once the glob itself passes {@link PATH_GLOB_MAX}, or
 * once the glob×path table would pass {@link PATH_GLOB_TABLE_MAX} cells. The matcher holds that
 * table, and a member-supplied scope must not be able to allocate one of unbounded size. A short
 * scope against a long repo path stays under the cell cap and still matches. A glob with no `**`
 * never builds the table: it goes through {@link segmentMatches}, which is already bounded.
 */
const PATH_GLOB_MAX = 4096;
const PATH_GLOB_TABLE_MAX = 1_048_576;

function globHasDoubleStar(glob: string): boolean {
  for (let i = 0; i < glob.length - 1; i++) {
    if (glob[i] === '*' && glob[i + 1] === '*') return true;
  }
  return false;
}

/**
 * Path-flavor glob match: the same language as `globToRegExp(glob, 'path')` (`*` stays inside one
 * segment, `**` crosses `/`, a double-star slash is an optional prefix), without compiling a
 * RegExp. A run of `*` against a long near-miss backtracks that regex without bound, and
 * `laneCoveringPath` runs it on every edit-gate check (the same shape ADR 575 closed for
 * `globsOverlap`). No `**` splits on `/` and uses {@link segmentMatches}. A `**` walks a glob×path
 * table, each cell once.
 */
export function pathGlobMatches(glob: string, path: string): boolean {
  if (!globHasDoubleStar(glob)) {
    const gs = glob.split('/');
    const ps = path.split('/');
    if (gs.length !== ps.length) return false;
    for (let i = 0; i < gs.length; i++) {
      if (!segmentMatches(gs[i]!, ps[i]!)) return false;
    }
    return true;
  }
  if (glob.length > PATH_GLOB_MAX || (glob.length + 1) * (path.length + 1) > PATH_GLOB_TABLE_MAX) {
    return false;
  }
  const G = glob.length;
  const P = path.length;
  const ok = new Uint8Array((G + 1) * (P + 1));
  const at = (gi: number, pi: number) => gi * (P + 1) + pi;
  ok[at(G, P)] = 1;
  for (let gi = G - 1; gi >= 0; gi--) {
    if (glob.startsWith('**/', gi)) {
      let suffix = 0;
      const slashFrom = new Uint8Array(P + 1);
      for (let j = P - 1; j >= 0; j--) {
        if (path[j] === '/' && ok[at(gi + 3, j + 1)] === 1) suffix = 1;
        slashFrom[j] = suffix;
      }
      for (let pi = 0; pi <= P; pi++) {
        if (ok[at(gi + 3, pi)] === 1 || slashFrom[pi] === 1) ok[at(gi, pi)] = 1;
      }
    } else if (glob.startsWith('**', gi)) {
      for (let pi = P; pi >= 0; pi--) {
        if (ok[at(gi + 2, pi)] === 1 || (pi < P && ok[at(gi, pi + 1)] === 1)) ok[at(gi, pi)] = 1;
      }
    } else if (glob[gi] === '*') {
      for (let pi = P; pi >= 0; pi--) {
        if (ok[at(gi + 1, pi)] === 1 || (pi < P && path[pi] !== '/' && ok[at(gi, pi + 1)] === 1)) {
          ok[at(gi, pi)] = 1;
        }
      }
    } else {
      const ch = glob[gi];
      for (let pi = 0; pi < P; pi++) {
        if (path[pi] === ch && ok[at(gi + 1, pi + 1)] === 1) ok[at(gi, pi)] = 1;
      }
    }
  }
  return ok[at(0, 0)] === 1;
}

/**
 * Glob-vs-glob surface intersection, segment by segment (ADR 083; ADR 575). Two declared surfaces
 * overlap when every segment they both have can name the same thing: equal, one a wildcard segment
 * matching the other's literal, or both wildcards. A `**` absorbs the rest, and a surface that runs
 * out first is a directory covering what lies under it. Still not a full glob engine: two wildcard
 * segments are assumed to meet, so it errs towards warning. It used to compare only the literal text
 * before the first wildcard, so a glob for every package's `package.json` read as `packages` and
 * overlapped every file in every package.
 */
export function globsOverlap(a: string, b: string): boolean {
  const sa = a.split('/').filter(Boolean);
  const sb = b.split('/').filter(Boolean);
  const wild = (seg: string) => seg.includes('*');
  const meets = (x: string, y: string) =>
    x === y ||
    (wild(x) && wild(y)) ||
    x.length > OVERLAP_SEGMENT_MAX ||
    y.length > OVERLAP_SEGMENT_MAX ||
    (wild(x) && segmentMatches(x, y)) ||
    (wild(y) && segmentMatches(y, x));
  for (let i = 0; ; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined || y === undefined || x === '**' || y === '**') return true;
    if (!meets(x, y)) return false;
  }
}

/**
 * The first **contending** lane (claimed/active/blocked) whose declared `scope` covers the given
 * concrete path — path-vs-glob via {@link pathGlobMatches}, NOT the cheap glob-vs-glob prefix
 * `globsOverlap` uses. This is the read behind ADR 150 Gate A: "does <seat> own a claimed lane
 * covering this edit?" (pass `owner`), and its blocked cousin "is any seat's lane covering it?"
 * (omit `owner`, for the denial's "owned by X" vs "claim one" copy). The path must arrive
 * repo-relative (the hook normalizes it), matching how lanes declare their globs.
 */
export async function laneCoveringPath(
  db: Driver,
  teamId: string,
  teamSlug: string,
  path: string,
  opts: { owner?: string } = {},
): Promise<Lane | null> {
  const lanes = (
    await listLanes(db, teamId, teamSlug, {
      ...(opts.owner ? { owner: opts.owner } : {}),
    })
  ).filter((l) => CONTENDING.has(l.state));
  for (const lane of lanes) {
    for (const glob of lane.scope) {
      if (pathGlobMatches(glob, path)) return lane;
    }
  }
  return null;
}

/** A scope entry that names one path outright — no `*`, `?` or `[` — rather than an area (ADR 691). */
export function isNamedFile(glob: string): boolean {
  return glob.length > 0 && !/[*?[]/.test(glob);
}

/** Tenure order for the hold: earlier claim first, lane id (creation order) as the tie-break. */
function claimOrder(a: Lane, b: Lane): number {
  const ta = a.claimed_at ?? Number.MAX_SAFE_INTEGER;
  const tb = b.claimed_at ?? Number.MAX_SAFE_INTEGER;
  return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The lane that HOLDS a file (ADR 691): among contending, owned lanes whose scope names `path`
 * outright (not through a glob), the one claimed first. Naming a file is a claim of exclusive use
 * for the lane's tenure; an area glob is not. Null when no contending lane names the path, which
 * leaves the edit to ADR 150's covering-lane rule alone. The same project rule as the overlap
 * warning applies: a lane in another project never holds a file here.
 */
export async function laneHoldingFile(
  db: Driver,
  teamId: string,
  teamSlug: string,
  path: string,
  project?: string,
): Promise<Lane | null> {
  const lanes = (await listLanes(db, teamId, teamSlug))
    .filter((l) => CONTENDING.has(l.state) && l.owner_seat !== null)
    .filter((l) => project === undefined || projectsContend(l.project, project))
    .filter((l) => l.scope.some((g) => isNamedFile(g) && g === path))
    .sort(claimOrder);
  return lanes[0] ?? null;
}

/**
 * Do two lanes share a surface-space? Same project, or either side unscoped — `'default'` is a
 * wildcard, not a peer project (see `DEFAULT_PROJECT`). Until derivation landed every lane was
 * `'default'`, so without the wildcard a derived-project lane and a legacy one would go mutually
 * blind the day derivation shipped — `project` is stamped at open and the board would simply stop
 * warning, which is the exact failure the scoping exists to prevent, inverted.
 */
export function projectsContend(a: string, b: string): boolean {
  return a === b || a === DEFAULT_PROJECT || b === DEFAULT_PROJECT;
}

/**
 * The two Phase-1 checks (ADR 083 §3), computed live for one lane. Warn-only — callers never gate.
 * (a) unmet_dependency: a depends_on target not `done`. (b) surface_overlap: declared globs intersect
 * another *contending* lane's in the same project (an unscoped lane contending with all of them).
 */
/** goals-front-door design: advisory nudge — a lane on no goal while goals are in flight.
 *  `with` = the first unshipped goal in ADR 257 order (a suggestion); owner null = never a directed wake. */
export function noGoalWarning(lane: Lane, goals: Goal[]): LaneWarning | null {
  if (lane.goal_id !== null) return null;
  const unshipped = goals.filter((g) => g.status !== 'shipped');
  if (unshipped.length === 0) return null;
  const suggest = [...unshipped].sort(compareGoals)[0]!;
  return {
    kind: 'no_goal',
    subject: lane.id,
    with: suggest.id,
    owner: null,
    detail: `on no goal — ${unshipped.length} in flight; link it: lane_update {goal_id: "${suggest.id}"} (or another)`,
  };
}

/** When a lane entered the acceptance stage: the latest `lane.ready_for_review` audit row, falling
 *  back to `updated_at` for pre-audit lanes (value-layer design — shared by the warning + brief). */
export async function acceptanceEnteredAt(db: Driver, teamId: string, lane: Lane): Promise<number> {
  const row = await db.get<{ ts: number }>(
    `SELECT ts FROM audit
        WHERE team_id = ? AND action = 'lane.ready_for_review' AND target = ?
        ORDER BY ts DESC LIMIT 1`,
    [teamId, lane.id],
  );
  return row?.ts ?? lane.updated_at;
}

/**
 * Was this lane's acceptance stage entered with NOBODY asked to review it?
 *
 * `pickReviewCounterpart` returns null when the live roster offers no gradeable counterpart — on a
 * same-model monoculture, which ADR 188/253 refuse to route, that is every seat. Busy live peers are
 * not in that set (ADR 404): they are asked when no quiet peer exists. The submit records
 * `no_candidate: true` on its `lane.ready_for_review` row and the lane then waits exactly like one
 * whose reviewer is simply slow. Reading it back is what lets the brief say which it is.
 *
 * Latest row wins, mirroring {@link acceptanceEnteredAt}: a re-submit re-routes, so an older row's
 * verdict is stale. Unreadable or absent detail ⇒ false — an old lane predating the field is
 * reported as routed rather than as a silence nobody can confirm.
 */
export async function readyForReviewHadNoCandidate(
  db: Driver,
  teamId: string,
  laneId: string,
): Promise<boolean> {
  const row = await db.get<{ detail: string | null }>(
    `SELECT detail FROM audit
        WHERE team_id = ? AND action = 'lane.ready_for_review' AND target = ?
        ORDER BY ts DESC LIMIT 1`,
    [teamId, laneId],
  );
  if (!row?.detail) return false;
  try {
    return (JSON.parse(row.detail) as { no_candidate?: unknown }).no_candidate === true;
  } catch {
    return false;
  }
}

/**
 * ADR 404: why the submit asked nobody, derived from the ready-row snapshot so historical
 * `no_candidate` rows still classify (busy vs empty room) without a new audit field.
 */
export async function emptyPoolFromSubmitAudit(
  db: Driver,
  teamId: string,
  laneId: string,
): Promise<EmptyPool | null> {
  const row = await db.get<{ detail: string | null }>(
    `SELECT detail FROM audit
        WHERE team_id = ? AND action = 'lane.ready_for_review' AND target = ?
        ORDER BY ts DESC LIMIT 1`,
    [teamId, laneId],
  );
  if (!row?.detail) return null;
  try {
    const d = JSON.parse(row.detail) as {
      no_candidate?: unknown;
      review_selection?: {
        selected?: { reviewer: string } | null;
        candidates?: Array<{ member: string; exclusion?: string }>;
      };
    };
    if (d.no_candidate !== true) return null;
    const sel = d.review_selection;
    if (!sel?.candidates) return null;
    return emptyPoolFromCandidates(sel.selected ?? null, sel.candidates);
  } catch {
    return null;
  }
}

/** value-layer design: review debt made visible — a lane waiting on acceptance past the threshold.
 *  Advisory like `no_goal`: owner null, never a directed wake. Entry time = the latest
 *  `lane.ready_for_review` audit row; falls back to `updated_at` for pre-audit lanes. A negative
 *  wait (clock skew) never emits. */
export async function staleAcceptanceWarning(
  db: Driver,
  teamId: string,
  lane: Lane,
  now: number,
): Promise<LaneWarning | null> {
  if (!isAwaitingAcceptance(lane.state)) return null;
  const waited = now - (await acceptanceEnteredAt(db, teamId, lane));
  if (waited < ACCEPTANCE_STALE_MS) return null;
  const hours = Math.floor(waited / 3_600_000);
  return {
    kind: 'stale_acceptance',
    subject: lane.id,
    with: lane.id,
    owner: null,
    detail: `waiting ${hours}h for acceptance — team_next surfaces it; any seat may answer per the acceptance ask`,
  };
}

/**
 * ADR 505 §6 — what a claimer is building on: each FINISHED dependency with how it closed and the
 * acceptor's own words, capped at three. `laneWarnings` names an unfinished dependency; a finished
 * one was silent, so its outcome, PR and note were invisible at the one moment someone started
 * building on them. Read-only; the note is the head of the `accept` that answered the lane's
 * standing review ask, and `closed_by`/`verified` come off the `lane.closed` row (ADR 169).
 */
export async function builtOn(
  db: Driver,
  teamId: string,
  teamSlug: string,
  lane: Lane,
  cap = 3,
): Promise<BuiltOn[]> {
  const out: BuiltOn[] = [];
  for (const depId of lane.depends_on) {
    if (out.length >= cap) break;
    const dep = await getLane(db, teamId, depId, teamSlug);
    if (!dep || dep.state !== 'done') continue;
    const closed = await db.get<{ detail: string | null }>(
      `SELECT detail FROM audit WHERE team_id = ? AND action = 'lane.closed' AND target = ?
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [teamId, dep.id],
    );
    let closedBy: string | undefined;
    let verified: boolean | undefined;
    if (closed?.detail) {
      try {
        const d = JSON.parse(closed.detail) as { closed_by?: unknown; verified?: unknown };
        if (typeof d.closed_by === 'string') closedBy = d.closed_by;
        if (typeof d.verified === 'boolean') verified = d.verified;
      } catch {
        /* an unreadable row names nothing — the line still says done */
      }
    }
    const accept = await db.get<{ body: string }>(
      // The routed reviewer's own accept (`r.from_member = a.to_member`), never a bystander's or
      // the owner's: an accept is a reply anyone may send on any id, and this line is shown to a
      // claimer as "the acceptor's words" (security review, 2026-10-05). `lane_review` itself is
      // server-stamped, so the ask side cannot be forged.
      `SELECT r.body AS body FROM messages a
         JOIN messages r ON r.team_id = a.team_id AND r.in_reply_to = a.id AND r.act = 'accept'
          AND r.from_member = a.to_member
        WHERE a.team_id = ? AND a.act = 'ask' AND json_extract(a.meta, '$.lane_review.lane') = ?
          AND json_extract(a.meta, '$.lane_review.advisory') IS NULL
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
      [teamId, dep.id],
    );
    const note = accept?.body.trim();
    out.push({
      lane: dep.id,
      title: dep.title,
      state: dep.state,
      ...(dep.merged && (dep.merged.pr !== undefined || dep.merged.sha !== undefined)
        ? {
            merged: {
              ...(dep.merged.pr !== undefined ? { pr: dep.merged.pr } : {}),
              ...(dep.merged.sha !== undefined ? { sha: dep.merged.sha } : {}),
            },
          }
        : {}),
      ...(closedBy !== undefined ? { closed_by: closedBy } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(note ? { note: note.length > 200 ? `${note.slice(0, 200)}…` : note } : {}),
    });
  }
  return out;
}

const BRANCH_FILE_CACHE = new Map<string, string[] | null>();

const BRANCH_OVERLAP_EXCLUDED = new Set([
  'ROADMAP.md',
  'pnpm-lock.yaml',
  'docs/implementation-plan.md',
]);

function branchTipSha(root: string, branch: string): string | null {
  try {
    return (
      execFileSync('git', ['-C', root, 'rev-parse', `${branch}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function branchChangedFiles(root: string, branch: string): string[] {
  const tip = branchTipSha(root, branch);
  if (!tip) return [];
  const key = root + '\u0000' + branch + '\u0000' + tip;
  if (BRANCH_FILE_CACHE.has(key)) {
    return BRANCH_FILE_CACHE.get(key) ?? [];
  }
  let files: string[] | null = null;
  try {
    const base = execFileSync('git', ['-C', root, 'merge-base', 'origin/main', branch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (base) {
      const out = execFileSync('git', ['-C', root, 'diff', '--name-only', `${base}..${branch}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      files = out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((f) => !BRANCH_OVERLAP_EXCLUDED.has(f));
    }
  } catch {
    files = null;
  }
  BRANCH_FILE_CACHE.set(key, files);
  return files ?? [];
}

export async function laneWarnings(
  db: Driver,
  teamId: string,
  teamSlug: string,
  lane: Lane,
  goals?: Goal[],
  now = Date.now(),
  /** The whole board, when the caller already read it — contention is checked against every lane,
   *  so without this each lane's warnings re-read the table (lane 01M3ANEQVR). */
  board?: Lane[],
): Promise<LaneWarning[]> {
  const warnings: LaneWarning[] = [];
  const byId = board ? new Map(board.map((l) => [l.id, l])) : null;
  for (const depId of lane.depends_on) {
    const dep = byId ? (byId.get(depId) ?? null) : await getLane(db, teamId, depId, teamSlug);
    if (!dep || dep.state === 'done') continue;
    warnings.push({
      kind: 'unmet_dependency',
      subject: lane.id,
      with: depId,
      owner: dep.owner_seat,
      detail: `building on "${dep.title}" (owner ${dep.owner_seat ?? 'unowned'}), still ${dep.state}`,
    });
  }
  if (lane.scope.length > 0 && CONTENDING.has(lane.state)) {
    for (const other of board ?? (await listLanes(db, teamId, teamSlug))) {
      if (other.id === lane.id || !CONTENDING.has(other.state)) continue;
      if (!projectsContend(lane.project, other.project)) continue;
      const shared = lane.scope.flatMap((g) =>
        other.scope.filter((og) => globsOverlap(g, og)).map((og) => `${g} ∩ ${og}`),
      );
      if (shared.length > 0) {
        // ADR 691: a file both lanes NAME is held by whichever claimed first. Say so at the claim,
        // precisely — this is the one overlap that will refuse an edit under block posture.
        const held =
          other.owner_seat !== null && claimOrder(other, lane) < 0
            ? lane.scope.filter((g) => isNamedFile(g) && other.scope.includes(g))
            : [];
        const holdNote =
          held.length > 0
            ? `; ${other.owner_seat} named ${held.join(', ')} first and holds it while that lane is in flight — under block posture your edits there are refused until it finishes, narrows, or is handed off (ADR 691)`
            : '';
        warnings.push({
          kind: 'surface_overlap',
          subject: lane.id,
          with: other.id,
          owner: other.owner_seat,
          detail: `surface overlaps "${other.title}" (owner ${other.owner_seat ?? 'unowned'}): ${shared.join(', ')}${holdNote}`,
        });
      }
    }
  }
  // branch_overlap: file-level comparison of pushed branches (ADR 637). Advisory only,
  // board-level, never a directed act. Opt-in via MUSTERD_BRANCH_OVERLAP=1 and only
  // when a repository root is available.
  if (process.env.MUSTERD_BRANCH_OVERLAP === '1' && lane.branch && CONTENDING.has(lane.state)) {
    const root = process.env.MUSTERD_REPO_ROOT ?? process.cwd();
    for (const other of board ?? (await listLanes(db, teamId, teamSlug))) {
      if (other.id === lane.id || !CONTENDING.has(other.state)) continue;
      if (!other.branch) continue;
      if (!projectsContend(lane.project, other.project)) continue;
      const a = branchChangedFiles(root, lane.branch);
      if (a.length === 0) continue;
      const bSet = new Set(branchChangedFiles(root, other.branch));
      const shared = a.filter((f) => bSet.has(f));
      if (shared.length === 0) continue;
      warnings.push({
        kind: 'branch_overlap',
        subject: lane.id,
        with: other.id,
        owner: other.owner_seat,
        detail: `branch overlaps "${other.title}" (owner ${other.owner_seat ?? 'unowned'}): ${shared.join(', ')}`,
      });
    }
  }

  if (CONTENDING.has(lane.state)) {
    const w = noGoalWarning(lane, goals ?? (await listGoals(db, teamId, teamSlug)));
    if (w) warnings.push(w);
  }
  // Independent of the CONTENDING gate: awaiting states are the review queue, not contention.
  const stale = await staleAcceptanceWarning(db, teamId, lane, now);
  if (stale) warnings.push(stale);
  const stalled = await stalledContinuationWarning(db, teamId, lane, now);
  if (stalled) warnings.push(stalled);
  return warnings;
}

/** Board-wide warnings: every contending lane's live warnings (GET /lanes annotates with these). */
export async function boardWarnings(
  db: Driver,
  teamId: string,
  teamSlug: string,
  lanes: Lane[],
  /** The unfiltered board, if the caller has it; `lanes` may be a filtered view (`?mine=1`), and
   *  contention must still be judged against every lane. Read once here otherwise. */
  board?: Lane[],
): Promise<LaneWarning[]> {
  board ??= await listLanes(db, teamId, teamSlug);
  const out: LaneWarning[] = [];
  const seen = new Set<string>();
  const goals = await listGoals(db, teamId, teamSlug);
  for (const lane of lanes) {
    for (const w of await laneWarnings(db, teamId, teamSlug, lane, goals, Date.now(), board)) {
      // A surface overlap is symmetric — report each pair once (keyed order-independently).
      const key =
        w.kind === 'surface_overlap'
          ? `${w.kind}:${[w.subject, w.with].sort().join(':')}`
          : `${w.kind}:${w.subject}:${w.with}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

/**
 * In-flight states a departed seat must not keep owning (ADR 196). `awaiting_acceptance` /
 * `ready_for_review` keep the owner name so outcome acceptance can still derive verified-ness.
 */
const RELEASE_ON_DEPART = "('claimed','active','blocked')" as const;

/**
 * The system as a releaser, named the way `SYSTEM_CLOSER` names the sweep. A departure release has
 * no seat behind it, and `null` would read as "actor unknown" — which is the defect this fixes.
 */
const SYSTEM_RELEASER = 'musterd';

/**
 * Release one lane back to `open` AND leave the `lane.released` row the PATCH path leaves
 * (`transport/http.ts`, same `detail` shape plus a `reason`). Increment 1 of ADR 325 made every
 * lane transition leave a durable row so a replicating daemon can fold history back out; these two
 * departure paths were the exceptions — the only places a lane changed hands with no record of who
 * or why (lane-replication spec §Finding 3). `appendAuditRequired`, not `appendAudit`: the release
 * and its record are one transaction, so a peer can never see the first without the second.
 */
async function releaseLaneWithRecord(
  db: Driver,
  teamId: string,
  laneId: string,
  ownerBefore: string,
  reason: 'seat_left' | 'seat_departed_sweep',
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE lanes SET state = 'open', owner_seat = NULL, claimed_at = NULL, updated_at = ?
     WHERE team_id = ? AND id = ?`,
    [now, teamId, laneId],
  );
  await appendLaneEventRequired(db, teamId, {
    actor: SYSTEM_RELEASER,
    action: 'lane.released',
    target: laneId,
    result: 'allow',
    detail: { lane: laneId, released_by: SYSTEM_RELEASER, owner_before: ownerBefore, reason },
  });
}

/**
 * Release a seat's in-flight lanes back to `open` (ADR 196 / open ⟺ unowned). Used when the seat
 * soft-leaves the roster so the board cannot assert ownership for a name every list filter drops.
 * Returns the released lane ids + prior state for logging/audit.
 */
export async function releaseInFlightClaimsForSeat(
  db: Driver,
  teamId: string,
  seatName: string,
  now: number = Date.now(),
): Promise<{ id: string; state_before: string }[]> {
  // Read and release inside one transaction: a lane re-owned between the read and the write must
  // not be released from its new owner (review I5, 2026-09-30).
  return await db.tx(async (t) => {
    const rows = await t.all<{ id: string; state: string }>(
      `SELECT id, state FROM lanes
         WHERE team_id = ? AND owner_seat = ? AND state IN ${RELEASE_ON_DEPART}`,
      [teamId, seatName],
    );
    for (const r of rows) await releaseLaneWithRecord(t, teamId, r.id, seatName, 'seat_left', now);
    return rows.map((r) => ({ id: r.id, state_before: r.state }));
  });
}

/**
 * Sweep in-flight lanes whose owner has already soft-left (ADR 196). Clears historical ghosts
 * left by pre-fix `leaveMember` calls; the reaper runs this every tick.
 *
 * `skipTeams` names teams this daemon is only a replica of: releasing a lane is a hub-owned
 * ownership edge (ADR 361 §1), so an enrolled joiner leaves it to the hub's own sweep.
 */
export async function releaseDepartedSeatClaims(
  db: Driver,
  now: number = Date.now(),
  skipTeams: ReadonlySet<string> = new Set(),
): Promise<{ team_id: string; seat: string; lane: string; state_before: string }[]> {
  return await db.tx(async (t) => {
    const found = await t.all<{
      lane: string;
      team_id: string;
      seat: string;
      state_before: string;
    }>(`SELECT l.id AS lane, l.team_id, l.owner_seat AS seat, l.state AS state_before
         FROM lanes l
         JOIN members m ON m.team_id = l.team_id AND m.name = l.owner_seat
         WHERE m.left_at IS NOT NULL
           AND l.state IN ${RELEASE_ON_DEPART}`);
    const rows = found.filter((r) => !skipTeams.has(r.team_id));
    for (const r of rows)
      await releaseLaneWithRecord(t, r.team_id, r.lane, r.seat, 'seat_departed_sweep', now);
    return rows;
  });
}
