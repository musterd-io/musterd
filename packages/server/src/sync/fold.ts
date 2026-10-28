import {
  ActSchema,
  ToolCallEventSchema,
  type SyncPullEvent,
  type SyncPullLaneEvent,
  isWireAttestationSource,
  LANE_TERMINAL_STATES,
  LanePreRegisteredSchema,
  LaneMetricSchema,
  LaneRequestedSchema,
  LaneSampleSchema,
  requestedRecordJson,
  type LaneState,
  StatusLineSchema,
  StylePrefsSchema,
} from '@musterd/protocol';
import { z } from 'zod';
import type { Driver } from '../db/driver.js';
import { appendAudit, REPLICATED_LEDGER_VERBS } from '../store/audit.js';
import { BOARD_SEAT, boardSeat } from '../store/boardSeat.js';
import { applyHaltLocally, applyResumeLocally } from '../store/halt.js';
import { projectHoldEvent } from '../store/holds.js';
import { deleteSample, upsertSample } from '../store/laneSamples.js';
import { getMemberByName, hostServiceSeat, hostServiceSeatName } from '../store/members.js';
import { parseWriter } from '../store/memory.js';
import { upsertForeignNode } from '../store/nodes.js';
import { stripPolicyRedactionMarkers } from '../store/policyRedaction.js';
import { POLICY_REVIEW_SEAT, policyReviewSeat } from '../store/policyReview.js';
import {
  applyFoldedEnrollment,
  isLiveHostLabel,
  recordHostSeen,
  recordSessionAttestation,
  revokeResidency,
} from '../store/residency.js';
import type { MemberRow, MessageRow, TeamRow } from '../store/rows.js';
import { applySeedCapture } from '../store/seeds.js';
import { setStylePrefs } from '../store/style.js';
import { recordToolCalls } from '../store/toolCalls.js';
import { assertSponsorCaller } from '../transport/authSponsor.js';
import { joinerEnrollment } from './claim.js';

/**
 * The fold (ADR 325 increment 3b-ii): apply the team's canonical order to THIS daemon's `messages`.
 *
 * This is the second insert path ADR 331 §Consequences warned about, and the whole slice is shaped
 * so there is exactly one of it, reviewed here, run by hub and puller alike. Three disciplines:
 *
 *  - **`nodes.next_seq` is never touched.** A folded row keeps the stamp its origin minted; the
 *    local allocator belongs to `insertMessage` alone. `fold.test.ts`'s first case is the falsifier.
 *  - **Idempotent on `(origin_node, origin_seq)`**, held by `idx_messages_origin` (v54) — not on
 *    `messages.id`, which ADR 335 deliberately left unique-per-origin only.
 *  - **Block, don't skip.** The first event that cannot be fully resolved stops the cursor AT that
 *    event; everything before it commits. Out-of-order application would make "everything up to N
 *    is applied" unanswerable, which is the one thing a cursor is for.
 *
 * `created_at` is this daemon's clock at fold time — never `envelope.ts`, which is the ORIGIN's
 * clock and travels (ADR 335 §1). The inbox and wake cursors are moving off `ts` onto `created_at`
 * for exactly that reason (spec §"The ts-cursor defect"); a wire value here would reintroduce the
 * defect under the fixed column.
 */

/**
 * ADR 645: a replicated declaration is parsed, never trusted, and `by` is the event's audited
 * actor — the seat the origin daemon authenticated — not whatever the payload says. A value that
 * fails the schema, or arrives with no audited actor, folds as undeclared.
 */
function foldedPreRegistered(value: unknown, actor: string | null): string | null {
  const parsed = LanePreRegisteredSchema.safeParse(value);
  if (!parsed.success) return null;
  // No audited actor means nobody to attribute it to; it never falls back to the payload's claim.
  if (actor === null) return null;
  return JSON.stringify({ ...parsed.data, by: actor });
}

export type FoldStop =
  | { kind: 'unresolved_seat'; seat: string; hub_seq: number }
  | { kind: 'unknown_act'; act: string; hub_seq: number }
  | { kind: 'id_collision'; id: string; hub_seq: number; held_origin: string }
  | { kind: 'origin_gap'; origin: string; expected: number; got: number; hub_seq: number }
  // Lane events (spec §"The wire, decided"). `unknown_lane_event` is `unknown_act`'s shape for the
  // second kind: a verb this build cannot project — upgrade this daemon, retried each tick.
  // `lane_unborn` is a transition for a lane this daemon never saw born: the origin's lane predates
  // `lane.opened` (2026-09-02) or the log has a hole. Applying it would mint a row with no title.
  | { kind: 'unknown_lane_event'; action: string; hub_seq: number }
  | { kind: 'lane_unborn'; lane: string; action: string; hub_seq: number }
  // Presence events (presence replication, 2026-09-02): the same two shapes for the third kind.
  // `unknown_presence_event` also covers a surface this build's CHECK cannot store — the origin
  // runs a newer build. `presence_unborn` is a re-attestation for a session this daemon never saw
  // attach: a hole, not a fact to invent a row from. (A detach for one is a no-op that advances —
  // the same fact arriving after our stale-node sweep.)
  | { kind: 'unknown_presence_event'; action: string; hub_seq: number }
  | { kind: 'presence_unborn'; presence: string; action: string; hub_seq: number }
  // Ledger events (ADR 365, ADR 393). There is no `unknown_ledger_event` for an unrecognised
  // VERB — a ledger row the fold has no projector for still lands in `audit`, and blocking would
  // wedge the fold on a fact that decides nothing. ADR 393 carves `residency.enrolled` /
  // `residency.revoked` as the exception that DOES project (into the `residency` table, so the
  // roster can tell the truth); an unknown seat there is git lag and stops as `unresolved_seat`.
  // The one refusal of the tag itself is a PROJECTED verb wearing the non-projecting tag: a
  // `lane.*`/`presence.*` action under `kind: 'ledger'` would land in `audit` with its stamp and
  // never reach its projector, leaving this daemon's `lanes` silently behind the origin's with no
  // gap to find it by.
  | { kind: 'mistagged_ledger_event'; action: string; hub_seq: number }
  // Policy events (residence-2 census gap 1, 2026-09-03): the fourth kind. Only the first shape —
  // there is no `unborn` for policy, because a team's row always exists here (the fold runs for a
  // team this daemon holds) and the event carries the WHOLE stored doc, not a delta. A verb this
  // build cannot project stops, retried each tick, the same as every other kind.
  | { kind: 'unknown_policy_event'; action: string; hub_seq: number }
  // Continuity events (residence-2 census gap 2, 2026-09-03): the fifth kind. `cursor_unborn` is
  // the cursor's own `unborn` shape — the message the cursor names has not folded here yet, so the
  // position it describes does not exist locally. Blocking is the point: skipping would leave the
  // cursor pointing at a place this daemon cannot resolve, and the next tick has the message.
  | { kind: 'unknown_continuity_event'; action: string; hub_seq: number }
  | { kind: 'cursor_unborn'; message: string; seat: string; hub_seq: number }
  // Record events (ADR 371, residence-2 census gap 3): the sixth kind. A record projects into a
  // TABLE (unlike the ledger), so a verb this build cannot project stops — a row nothing reads is
  // not a fact held honestly. There is no `unborn` stop: a seed-thread entry whose seed is not here
  // is HELD (ADR 500) — its audit row lands, and the seed's birth projects it — because an entry is
  // an append, and a seed captured before ADR 399 has no birth in the log to wait for.
  | { kind: 'unknown_record_event'; action: string; hub_seq: number }
  // Seed events (ADR 399): the seventh kind. A seed projects into a TABLE like a record, so an
  // unprojectable verb stops for the same reason. There is no `unborn` here — a capture depends on
  // nothing but its submitter, and an unresolved submitter is `unresolved_seat` as for every
  // seat-fact kind.
  | { kind: 'unknown_seed_event'; action: string; hub_seq: number };

/**
 * Each audited lane field a `lane.updated` carries, mapped to its column; `scope` keeps its
 * historical `surface_globs` column name. A field NOT here is one this build cannot project: the
 * fold stops at the event (`unknown_lane_event`, `lane.updated:<field>`) rather than apply the rest
 * and mark it applied, which lost `reads_on` on a hub that predated it for good (lane 01M56NXFFB).
 * `fold.test.ts` holds this to the writer's AUDITED_LANE_FIELDS, so a field added there without a
 * column here fails the build that adds it.
 */
export const LANE_UPDATE_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  detail: 'detail',
  project: 'project',
  role: 'role',
  scope: 'surface_globs',
  depends_on: 'depends_on',
  branch: 'branch',
  goal_id: 'goal_id',
  risk: 'risk',
  stakes: 'stakes',
  kind: 'kind',
  merged: 'merged_json',
  parked: 'parked_json',
  follows_up: 'follows_up_json',
  abandon_reason: 'abandon_reason',
  unfinished_todos: 'unfinished_todos_json',
  declared_areas: 'areas_json',
  source_ref: 'source_ref',
  declined: 'declined_json',
  requested: 'requested_json',
  reads_on: 'reads_on',
  read_verdict: 'read_verdict_json',
  pre_registered: 'pre_registered_json',
  metric: 'metric_json',
};

/** The fields of a `lane.updated` this build has no column for, in the event's order. */
function unmappedLaneFields(detail: unknown): string[] {
  const changes = (detail as { changes?: unknown } | null | undefined)?.changes;
  if (changes === null || typeof changes !== 'object') return [];
  return Object.keys(changes).filter((f) => !Object.hasOwn(LANE_UPDATE_COLUMNS, f));
}

/** The `lane.*` verbs the fold can project. Anything else stops as `unknown_lane_event`. */
const LANE_VERBS = new Set([
  'lane.opened',
  'lane.claimed',
  'lane.released',
  'lane.updated',
  // ADR 644: the trace of a read verdict; the verdict itself rides `lane.updated`.
  'lane.read_recorded',
  // ADR 673: a moved goalpost is held in audit; a sample projects into `lane_samples`.
  'lane.metric_changed',
  'lane.sample_recorded',
  // ADR 715: a derived sample taken back; the fold deletes the same row.
  'lane.sample_removed',
  'lane.state_changed',
  'lane.ready_for_review',
  'lane.closed',
  // Review verbs carry no state; they are held in `audit` for the readers that want them.
  'lane.review_sent_back',
  'lane.review_peer_confirmed',
  'lane.review_human_asked',
  'lane.review_acknowledged',
  'lane.review_advisory',
  'lane.review_unbound',
  'lane.review_rerouted',
  // ADR 682: the acceptor's claims (ADR 585) are evidence like the review verbs, and they cross
  // with them — the fold has to be able to NAME a verb that arrives, or it stops at it.
  'lane.claims_verified',
  // ADR 645's band-2 pull. `lane.pulled` joins a claim (which rides `lane.claimed`) to its
  // announcement and `lane.pull_declined` records a stopped window: both are held in audit.
  // `lane.pull_released` gives a dead pull's lane back, so it projects.
  'lane.pulled',
  'lane.pull_declined',
  'lane.pull_released',
]);

/**
 * A host's service seat is minted where the host first speaks (ADR 645, `hostServiceSeat`) and no
 * event carries the mint, so a joiner meets its first act with no such seat. Mint it here, the
 * same row the hub made — but only when the envelope itself names the host the seat folds from
 * (`meta.pull.host`). Any other unknown sender is git lag and still stops the fold.
 */
async function hostSeatFromEnvelope(
  db: Driver,
  teamId: string,
  env: { from: string; meta?: Record<string, unknown> | null | undefined },
): Promise<MemberRow | null> {
  const pull = env.meta?.['pull'];
  const host =
    pull && typeof pull === 'object' ? (pull as Record<string, unknown>)['host'] : undefined;
  if (typeof host !== 'string' || hostServiceSeatName(host) !== env.from) return null;
  const team = await db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
  return team ? hostServiceSeat(db, team, host) : null;
}

/**
 * The daemon's own service seats (`board`, ADR 646/649; `policy`, ADR 533) are minted db-only on
 * first use where they speak (ADR 232) and never ride the roster git carries, so a joiner meets
 * their first folded act with no seat to resolve. That wedged delta-2 at hub_seq 305458 on a
 * `board` dispatch nudge (2026-10-28): the stop is retried each tick, so every later event —
 * credentials included — waited behind a git file that will never exist. Mint the same row the
 * origin made, as the host seat above; any other unknown name is git lag and still stops.
 * Null when the name is already held by a non-service seat: the daemon never speaks as a person.
 */
async function daemonServiceSeatFromName(
  db: Driver,
  teamId: string,
  name: string,
): Promise<MemberRow | null> {
  if (name !== BOARD_SEAT && name !== POLICY_REVIEW_SEAT) return null;
  const team = await db.get<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
  if (!team) return null;
  return name === BOARD_SEAT ? boardSeat(db, team) : policyReviewSeat(db, team);
}

/**
 * Project one replicated lane transition into this daemon's `lanes` — the materialised fold the
 * spec chose over a read-time projection. Every case mirrors the origin's own write: what the
 * store did to its row when it wrote this verb, this does to ours. `null` when the lane has no row
 * here and the verb is not its birth.
 */
async function projectLaneEvent(
  db: Driver,
  teamId: string,
  event: SyncPullLaneEvent['event'],
): Promise<'applied' | 'unborn'> {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const laneId = (typeof d['lane'] === 'string' ? d['lane'] : event.target) ?? '';
  const ts = event.ts;
  const held = await db.get<{ id: string; state: string; resolved_at: number | null }>(
    'SELECT id, state, resolved_at FROM lanes WHERE team_id = ? AND id = ?',
    [teamId, laneId],
  );
  // A transition written BEFORE the lane's close can reach this daemon AFTER it: a joiner's
  // `lane.ready_for_review` pushed a minute late put three closed lanes back to awaiting_acceptance
  // on 2026-10-05. Origin order is per node, not across them, so a non-terminal move older than the
  // close is history only — held in audit, never projected. A reopen made after the close applies.
  const staleAgainstClose =
    held !== undefined &&
    LANE_TERMINAL_STATES.has(held.state as LaneState) &&
    held.resolved_at !== null &&
    ts < held.resolved_at;

  if (event.action === 'lane.opened') {
    // The birth carries the whole declaration (Finding 4). A replay past the idempotence check
    // cannot reach here, so a held row means two origins minted one lane id: keep ours, the way
    // `id_collision` keeps the message we hold — and say nothing, since the audit row is kept.
    if (held) return 'applied';
    const scope = Array.isArray(d['scope']) ? d['scope'] : [];
    const declaredAreas = Array.isArray(d['declared_areas']) ? d['declared_areas'] : [];
    const dependsOn = Array.isArray(d['depends_on']) ? d['depends_on'] : [];
    const risk = Array.isArray(d['risk']) ? d['risk'] : [];
    const stakes = typeof d['stakes'] === 'string' ? d['stakes'] : 'normal';
    const provenance = typeof d['stakes_provenance'] === 'string' ? d['stakes_provenance'] : null;
    const requested = LaneRequestedSchema.safeParse(d['requested']);
    await db.run(
      `INSERT INTO lanes (id, team_id, project, title, detail, kind, owner_seat, role, surface_globs,
                          depends_on, branch, goal_id, risk, stakes, stakes_provenance, merged_json, areas_json, source_ref,
                          requested_json, reads_on, pre_registered_json, metric_json, state, created_by, created_at, claimed_at, resolved_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?)`,
      [
        laneId,
        teamId,
        typeof d['project'] === 'string' ? d['project'] : 'default',
        typeof d['title'] === 'string' ? d['title'] : '',
        typeof d['detail'] === 'string' ? d['detail'] : null,
        typeof d['kind'] === 'string' ? d['kind'] : null,
        typeof d['role'] === 'string' ? d['role'] : null,
        JSON.stringify(scope),
        JSON.stringify(dependsOn),
        typeof d['branch'] === 'string' ? d['branch'] : null,
        typeof d['goal_id'] === 'string' ? d['goal_id'] : null,
        risk.length > 0 ? JSON.stringify(risk) : null,
        stakes !== 'normal' ? stakes : null,
        provenance === 'defaulted' ? 'defaulted' : null,
        declaredAreas.length > 0 ? JSON.stringify(declaredAreas) : null,
        // ADR 561: carried, never judged — the fold applies history, so a ref another live lane
        // already holds lands anyway (each daemon refuses at its own write; re-sync names the rest).
        typeof d['source_ref'] === 'string' ? d['source_ref'] : null,
        requested.success ? requestedRecordJson(requested.data) : null,
        typeof d['reads_on'] === 'string' ? d['reads_on'] : null,
        // ADR 645: parsed, never trusted — a row that fails the schema folds as undeclared.
        foldedPreRegistered(d['pre_registered'], event.actor),
        foldedMetric(d['metric']),
        typeof d['created_by'] === 'string' ? d['created_by'] : (event.actor ?? ''),
        typeof d['created_at'] === 'number' ? d['created_at'] : ts,
        typeof d['created_at'] === 'number' ? d['created_at'] : ts,
      ],
    );
    return 'applied';
  }
  if (!held) return 'unborn';

  switch (event.action) {
    case 'lane.claimed': {
      const owner = typeof d['owner'] === 'string' ? d['owner'] : event.actor;
      await db.run(
        `UPDATE lanes SET owner_seat = ?, state = CASE WHEN state = 'open' THEN 'claimed' ELSE state END,
                          claimed_at = ?, updated_at = ? WHERE team_id = ? AND id = ?`,
        [owner, ts, ts, teamId, laneId],
      );
      return 'applied';
    }
    case 'lane.released':
      if (staleAgainstClose) return 'applied';
      await db.run(
        `UPDATE lanes SET owner_seat = NULL, state = 'open', claimed_at = NULL, updated_at = ?
          WHERE team_id = ? AND id = ?`,
        [ts, teamId, laneId],
      );
      return 'applied';
    case 'lane.pull_released': {
      // The origin released only while the pulled seat still held the lane; mirror that guard,
      // so a release that raced a later claim here takes nothing from the new owner.
      if (staleAgainstClose) return 'applied';
      const ownerBefore = typeof d['owner_before'] === 'string' ? d['owner_before'] : null;
      await db.run(
        `UPDATE lanes SET owner_seat = NULL, state = 'open', claimed_at = NULL, updated_at = ?
          WHERE team_id = ? AND id = ? AND owner_seat = ?`,
        [ts, teamId, laneId, ownerBefore],
      );
      return 'applied';
    }
    case 'lane.state_changed': {
      const to = typeof d['to'] === 'string' ? d['to'] : null;
      if (to === null) return 'applied';
      const terminal = LANE_TERMINAL_STATES.has(to as LaneState);
      if (staleAgainstClose && !terminal) return 'applied';
      // ADR 466: parking releases the owner (the origin store's release invariant); the park
      // record itself follows in the same write's `lane.updated` row (`parked` field).
      if (to === 'parked')
        await db.run(
          `UPDATE lanes SET state = ?, owner_seat = NULL, claimed_at = NULL, updated_at = ?
            WHERE team_id = ? AND id = ?`,
          [to, ts, teamId, laneId],
        );
      else if (terminal)
        await db.run('UPDATE lanes SET state = ?, updated_at = ? WHERE team_id = ? AND id = ?', [
          to,
          ts,
          teamId,
          laneId,
        ]);
      // Leaving a terminal state clears resolved_at, as the origin store does (`updateLaneInTx`).
      else
        await db.run(
          'UPDATE lanes SET state = ?, resolved_at = NULL, updated_at = ? WHERE team_id = ? AND id = ?',
          [to, ts, teamId, laneId],
        );
      return 'applied';
    }
    case 'lane.ready_for_review':
      if (staleAgainstClose) return 'applied';
      await db.run(
        "UPDATE lanes SET state = 'awaiting_acceptance', updated_at = ? WHERE team_id = ? AND id = ?",
        [ts, teamId, laneId],
      );
      return 'applied';
    case 'lane.closed': {
      const state = typeof d['state'] === 'string' ? d['state'] : 'done';
      await db.run(
        'UPDATE lanes SET state = ?, resolved_at = ?, updated_at = ? WHERE team_id = ? AND id = ?',
        [state, ts, ts, teamId, laneId],
      );
      return 'applied';
    }
    case 'lane.updated': {
      // `changes: { field: { from, to } }` — values since hole 2. Each audited field maps to its
      // column; `scope` keeps its historical `surface_globs` column name.
      const changes = (d['changes'] ?? {}) as Record<string, { to?: unknown }>;
      for (const [field, change] of Object.entries(changes)) {
        const col = LANE_UPDATE_COLUMNS[field];
        if (!col) continue; // unreachable for a pulled event: the caller stops on an unmapped field first
        let value: unknown = change.to ?? null;
        if (field === 'scope' || field === 'depends_on') value = JSON.stringify(value ?? []);
        else if (field === 'risk' || field === 'declared_areas')
          value = Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null;
        else if (field === 'stakes') value = value === 'normal' ? null : value;
        else if (
          field === 'merged' ||
          field === 'parked' ||
          field === 'follows_up' ||
          field === 'unfinished_todos' ||
          field === 'declined' ||
          field === 'read_verdict'
        )
          value = value === null ? null : JSON.stringify(value);
        else if (field === 'pre_registered') value = foldedPreRegistered(value, event.actor);
        else if (field === 'metric') value = foldedMetric(value);
        else if (field === 'requested') {
          if (value === null) value = null;
          else {
            const parsed = LaneRequestedSchema.safeParse(value);
            if (!parsed.success) continue;
            value = requestedRecordJson(parsed.data);
          }
        }
        await db.run(`UPDATE lanes SET ${col} = ?, updated_at = ? WHERE team_id = ? AND id = ?`, [
          value,
          ts,
          teamId,
          laneId,
        ]);
      }
      return 'applied';
    }
    case 'lane.sample_recorded': {
      // ADR 673: the sample itself, parsed, never trusted — one that fails the schema is held in
      // audit and projects nothing. Same upsert as the origin's write.
      const sample = LaneSampleSchema.safeParse(d);
      if (sample.success) await upsertSample(db, teamId, laneId, sample.data);
      return 'applied';
    }
    case 'lane.sample_removed': {
      // ADR 715: only a well-formed day is acted on; anything else is held in audit and projects nothing.
      const day = d['day'];
      if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
        await deleteSample(db, teamId, laneId, day);
      return 'applied';
    }
    default:
      return 'applied';
  }
}

/** ADR 673: a replicated metric as the column stores it, or null when it does not parse. */
function foldedMetric(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = LaneMetricSchema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

/**
 * The verbs the policy kind carries — hub-minted Team rules: the policy override and (ADR 516) the
 * Team's holds. Anything else stops as `unknown_policy_event`.
 */
const POLICY_VERBS = new Set([
  'policy.change',
  'hold.set',
  'hold.lifted',
  // ADR 525: a human's halt/resume, decided on the hub.
  'seat.halted',
  'seat.resumed',
  // ADR 514 (lane 01M46RWP23): a human's own style prefs, written on the hub.
  'style.prefs',
  // ADR 721: a human's own status line, written on the hub.
  'status_line',
]);

/**
 * Project a replicated policy change into this daemon's `teams.policy` (residence-2 census gap 1).
 *
 * Replace semantics, exactly as `setPolicy` has them: the event's `detail` is the whole STORED
 * sparse override, so a key it omits is unset here too and this build's own default comes back to
 * life for it. Nothing is merged into the local row — a merge would let a knob an admin cleared on
 * the hub survive forever on every machine that once held it.
 *
 * `policy` is hub-authoritative, so this is a one-writer projection: last hub event wins, and there
 * is no per-machine value to reconcile against. `updated_at` is the local clock at fold time, like
 * every other folded row's receipt stamp.
 */
async function projectPolicyEvent(
  db: Driver,
  teamId: string,
  event: SyncPullLaneEvent['event'],
  now: number,
  halted: string[] = [],
): Promise<'applied' | 'unknown'> {
  if (event.action === 'seat.halted' || event.action === 'seat.resumed') {
    // ADR 525: apply the hub's decision with the hub's stamp. A seat this node does not know has
    // nothing here to stop — applied, not a stop: the fold must not wedge on a roster difference.
    const at = event.detail?.['at'];
    const by = event.actor;
    if (typeof at !== 'number' || !by) return 'unknown';
    const seat = await getMemberByName(db, teamId, event.target ?? '');
    if (!seat || seat.kind !== 'agent') return 'applied';
    if (event.action === 'seat.resumed') {
      await applyResumeLocally(db, seat, at);
      return 'applied';
    }
    const reason = event.detail?.['reason'];
    if (typeof reason !== 'string' || !reason) return 'unknown';
    if ((await applyHaltLocally(db, teamId, seat, by, reason, at)).changed) halted.push(seat.id);
    return 'applied';
  }
  if (event.action === 'hold.set' || event.action === 'hold.lifted') {
    return projectHoldEvent(db, teamId, event.action, event.detail);
  }
  if (event.action === 'style.prefs') {
    // ADR 514: the hub's copy of a human's prefs, whole. A human this node does not know has no
    // row to carry them — applied, not a stop, like a halt for an unknown seat. A shape the schema
    // refuses is a stop: a wrong prefs blob would silently rewrite how every seat here talks.
    const prefs = StylePrefsSchema.safeParse(event.detail?.['prefs']);
    if (!prefs.success || !event.actor) return 'unknown';
    const human = await getMemberByName(db, teamId, event.actor);
    if (!human || human.kind !== 'human') return 'applied';
    await setStylePrefs(db, human.id, prefs.data);
    return 'applied';
  }
  if (event.action === 'status_line') {
    // ADR 721: the hub's status line for a human, whole, or null to clear. A human this node does not
    // know is applied, not a stop; a shape the schema refuses is a stop.
    const raw = event.detail?.['line'];
    const line = raw === null || raw === undefined ? null : StatusLineSchema.safeParse(raw).data;
    if (line === undefined || !event.actor) return 'unknown';
    const human = await getMemberByName(db, teamId, event.actor);
    if (!human || human.kind !== 'human') return 'applied';
    await db.run('UPDATE members SET status_line = ?, updated_at = ? WHERE id = ?', [
      line ? JSON.stringify(line) : null,
      now,
      human.id,
    ]);
    return 'applied';
  }
  if (event.action !== 'policy.change') return 'unknown';
  const stored = stripPolicyRedactionMarkers(event.detail ?? {});
  await db.run('UPDATE teams SET policy = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(stored),
    now,
    teamId,
  ]);
  return 'applied';
}

/** The `seed.*` verbs the fold can project. Anything else stops as `unknown_seed_event`. */
const SEED_VERBS = new Set(['seed.captured']);

/**
 * Project a replicated seed capture (ADR 399) into `seeds`. Nothing here decides: the insert is
 * idempotent on `(team_id, relay_id)`, so a re-delivered batch is a no-op and a node that already
 * relay-ingested the same capture keeps its own row.
 *
 * The seed's LIFECYCLE is not projected — no state, no explorer (ADR 371 §3, unchanged). What
 * crosses is the capture: the relay id, the body, who submitted it, and the lane a repo capture was
 * born promoted against. An explorer claim is "exactly one holder" and stays a residence-1 question
 * for the federation increment.
 */
async function projectSeedEvent(
  db: Driver,
  teamId: string,
  event: SyncPullLaneEvent['event'],
  submitterId: string,
  now: number,
): Promise<'applied' | 'unknown'> {
  if (event.action !== 'seed.captured') return 'unknown';
  const d = event.detail ?? {};
  const relayId = d['relay_id'];
  const body = d['body'];
  const source = d['source'];
  if (typeof relayId !== 'string' || typeof body !== 'string' || typeof source !== 'string') {
    return 'unknown';
  }
  await applySeedCapture(
    db,
    teamId,
    {
      relay_id: relayId,
      source,
      body,
      captured_at: typeof d['captured_at'] === 'number' ? d['captured_at'] : event.ts,
      slack_user_id: typeof d['slack_user_id'] === 'string' ? d['slack_user_id'] : null,
      linked_lane_id: typeof d['linked_lane_id'] === 'string' ? d['linked_lane_id'] : null,
      promotion_kind: typeof d['promotion_kind'] === 'string' ? d['promotion_kind'] : null,
    },
    submitterId,
    now,
  );
  return 'applied';
}

/** The `record.*` verbs the fold can project. Anything else stops as `unknown_record_event`. */
const RECORD_VERBS = new Set(['record.tool_calls', 'record.seed_thread', 'record.incident_report']);

/**
 * Project a replicated record (ADR 371) into its table. Nothing here decides: every projection is
 * an additive UPSERT or an idempotent INSERT, and the fold's Rule 2 (a held `(origin_node,
 * origin_seq)` pair is skipped before this runs) is what makes the additive one exactly-once.
 *
 * - `tool_calls`: the same hourly fold `recordToolCalls` runs, under the ORIGIN's `bucket_start` —
 *   the batch landed in that hour on the machine that measured it, and the report groups by hour.
 * - `seed_thread`: `seeds.id` and `members.id` are daemon-private, so the entry names the relay id
 *   and the member; both resolve HERE. The entry keeps the origin's id — one row, one key, on every
 *   machine — and the member is resolved by the caller (the seat rule every seat-fact kind shares).
 * - `incident_report`: the hub's pool row, mirrored read-only so `incidentReporters` answers on a
 *   joiner. The same verb carries the later `lane_id` stamp, hence the upsert on the id.
 */
async function projectRecordEvent(
  db: Driver,
  teamId: string,
  event: SyncPullLaneEvent['event'],
  memberId: string | null,
): Promise<'applied' | 'unknown' | 'seed_unborn'> {
  const d = event.detail ?? {};
  if (event.action === 'record.tool_calls') {
    const seat = typeof d['seat'] === 'string' ? d['seat'] : event.actor;
    const bucket = typeof d['bucket_start'] === 'number' ? d['bucket_start'] : event.ts;
    const parsed = z.array(ToolCallEventSchema).safeParse(d['events']);
    if (!seat || !parsed.success) return 'unknown';
    await recordToolCalls(
      db,
      teamId,
      seat,
      typeof d['role'] === 'string' ? d['role'] : null,
      parsed.data,
      bucket,
      // ADR 640: a record from a peer that predates `rail` came from a stdio adapter.
      d['rail'] === 'remote' ? 'remote' : 'stdio',
    );
    return 'applied';
  }
  if (event.action === 'record.seed_thread') {
    const entryId = d['entry_id'];
    const relayId = d['relay_id'];
    const kind = d['kind'];
    const body = d['body'];
    const createdAt = typeof d['created_at'] === 'number' ? d['created_at'] : event.ts;
    if (
      typeof entryId !== 'string' ||
      typeof relayId !== 'string' ||
      typeof kind !== 'string' ||
      typeof body !== 'string' ||
      !memberId
    )
      return 'unknown';
    const seed = await db.get<{ id: string }>(
      'SELECT id FROM seeds WHERE team_id = ? AND relay_id = ?',
      [teamId, relayId],
    );
    if (!seed) return 'seed_unborn';
    await db.run(
      `INSERT OR IGNORE INTO seed_thread_entries (id, seed_id, team_id, kind, body, member_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entryId, seed.id, teamId, kind, body, memberId, createdAt],
    );
    return 'applied';
  }
  if (event.action === 'record.incident_report') {
    const reportId = d['report_id'];
    const gate = d['gate'];
    const seat = typeof d['seat'] === 'string' ? d['seat'] : event.actor;
    if (typeof reportId !== 'string' || typeof gate !== 'string' || !seat) return 'unknown';
    await db.run(
      `INSERT INTO incident_reports (id, team_id, gate, seat, sig, ref, message_id, lane_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET lane_id = COALESCE(excluded.lane_id, incident_reports.lane_id)`,
      [
        reportId,
        teamId,
        gate,
        seat,
        typeof d['sig'] === 'string' ? d['sig'] : null,
        typeof d['ref'] === 'string' ? d['ref'] : null,
        typeof d['message_id'] === 'string' ? d['message_id'] : null,
        typeof d['lane_id'] === 'string' ? d['lane_id'] : null,
        typeof d['created_at'] === 'number' ? d['created_at'] : event.ts,
      ],
    );
    return 'applied';
  }
  return 'unknown';
}

/** The `continuity.*` verbs the fold can project. Anything else stops as `unknown_continuity_event`. */
const CONTINUITY_VERBS = new Set([
  'continuity.memory_saved',
  'continuity.memory_cleared',
  'continuity.cursor_advanced',
]);

/**
 * Project a replicated continuity event into this daemon's `seat_memory` / `inbox_cursors`
 * (residence-2 census gap 2). The seat is already resolved by the caller.
 *
 * MEMORY is last-writer-wins on the ORIGIN's clock. `saved_at` (or `cleared_at`) travels in the
 * event and is compared against the local row's `saved_at`; an older event loses and is applied as
 * a no-op rather than stopping, because a note that lost a race is not a hole in the log. One clock
 * per fact, the origin's — the rule ADR 335 sets for `ts` and the only one that survives two
 * machines whose wall clocks disagree by more than the gap between two saves.
 *
 * A CLEAR is a fact with a timestamp, not an absence: without one, a note a seat deliberately
 * dropped walks back in from the next peer that still holds it.
 *
 * CURSORS never carry a timestamp across. `last_read_message_id` is resolved against THIS daemon's
 * `messages.created_at`, and the cursor takes the max of that and where it already sits. This is
 * the ts-cursor defect (lane 01M1FAYTHQA881M35PDPXRTGM1) in federated form: `last_read_ts` is a
 * receipt clock, and the same message has a different one on every machine that folded it, so
 * max-merging the raw number would move the cursor to a position no local row ever occupied and
 * swallow the unread acts in between. A cursor is a place in the log; the place is re-read here.
 */
async function projectContinuityEvent(
  db: Driver,
  teamId: string,
  seat: { id: string; name: string; team_id: string },
  event: SyncPullLaneEvent['event'],
  now: number,
): Promise<'applied' | 'unknown' | 'cursor_unborn'> {
  const detail = event.detail ?? {};
  if (event.action === 'continuity.memory_saved') {
    const savedAt = typeof detail['saved_at'] === 'number' ? detail['saved_at'] : event.ts;
    const local = await db.get<{ saved_at: number }>(
      'SELECT saved_at FROM seat_memory WHERE member_id = ?',
      [seat.id],
    );
    if (local && local.saved_at >= savedAt) return 'applied';
    // No local note is NOT "nothing to compare against" (gptbot's decline of lane 01M1JNY14F,
    // 2026-09-03): a clear deleted the row, and a save minted BEFORE that clear on another machine
    // can still arrive after it. The clear's clock is held — every `continuity.memory_cleared` is an
    // audit row with `cleared_at`, this daemon's own included — so the delayed older save loses to
    // it here exactly as it would have lost to the row the clear removed. ADR 366 decision 4.
    if (!local) {
      const cleared = await db.get<{ t: number | null }>(
        `SELECT MAX(json_extract(detail, '$.cleared_at')) AS t FROM audit
            WHERE team_id = ? AND action = 'continuity.memory_cleared' AND actor = ?`,
        [teamId, seat.name],
      );
      if (cleared?.t != null && cleared.t >= savedAt) return 'applied';
    }
    await db.run(
      `INSERT INTO seat_memory (member_id, team_id, headline, body, saved_at, writer)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         headline = excluded.headline, body = excluded.body, saved_at = excluded.saved_at,
         writer = excluded.writer`,
      [
        seat.id,
        seat.team_id,
        typeof detail['headline'] === 'string' ? detail['headline'] : '',
        typeof detail['body'] === 'string' ? detail['body'] : '',
        savedAt,
        // ADR 654: the origin's writer stamp travels with the note; an older origin sends none.
        ((w) => (w ? JSON.stringify(w) : null))(parseWriter(detail['writer'])),
      ],
    );
    return 'applied';
  }
  if (event.action === 'continuity.memory_cleared') {
    const clearedAt = typeof detail['cleared_at'] === 'number' ? detail['cleared_at'] : event.ts;
    const local = await db.get<{ saved_at: number }>(
      'SELECT saved_at FROM seat_memory WHERE member_id = ?',
      [seat.id],
    );
    // A save made after the clear wins: the seat wrote a new note on another machine, and the
    // clear it raced is about the note that note replaced.
    if (local && local.saved_at > clearedAt) return 'applied';
    await db.run('DELETE FROM seat_memory WHERE member_id = ?', [seat.id]);
    return 'applied';
  }
  if (event.action === 'continuity.cursor_advanced') {
    const messageId = detail['last_read_message_id'];
    if (typeof messageId !== 'string') return 'unknown';
    const row = await db.get<{ created_at: number }>(
      'SELECT created_at FROM messages WHERE id = ?',
      [messageId],
    );
    if (!row) return 'cursor_unborn';
    const local = await db.get<{ last_read_ts: number; last_read_message_id: string | null }>(
      'SELECT last_read_ts, last_read_message_id FROM inbox_cursors WHERE member_id = ?',
      [seat.id],
    );
    // Forward only, measured in this daemon's own order — and that order is the `(created_at, id)`
    // point `listMessages` reads unread against (store/messages.ts), not `created_at` alone. Two
    // messages folded in one batch share a millisecond, and a cursor that compared only the clock
    // would refuse to move from the first to the second while `unread` still listed the second.
    // The continuity test caught exactly that. An event naming an EARLIER place is not a conflict
    // to resolve — the seat read further on some other machine, and that is already here.
    if (
      local &&
      (local.last_read_ts > row.created_at ||
        (local.last_read_ts === row.created_at && (local.last_read_message_id ?? '') >= messageId))
    ) {
      return 'applied';
    }
    await db.run(
      `INSERT INTO inbox_cursors (member_id, team_id, last_read_message_id, last_read_ts, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         last_read_message_id = excluded.last_read_message_id,
         last_read_ts = excluded.last_read_ts,
         updated_at = excluded.updated_at`,
      [seat.id, seat.team_id, messageId, row.created_at, now],
    );
    return 'applied';
  }
  return 'unknown';
}

const PRESENCE_VERBS = new Set(['presence.attached', 'presence.detached', 'presence.reattested']);

/** The surfaces this build's `presence` CHECK admits (migration 104). Keep in step with it. */
const STORABLE_SURFACES = new Set([
  'cli',
  'claude-code',
  'codex',
  'opencode',
  'grok',
  'cursor',
  'web',
  'ios',
  'slack',
  'other',
  'musterd',
  'muse',
]);

/**
 * Project one replicated presence transition into this daemon's `presence` (spec §2). `node` is
 * the origin; `conn_id`/`held_until`/`wake_lease` are NULL: nothing here heartbeats, holds, or
 * verifies a lease for a session on another machine. A detach for a row we no longer hold is the
 * same fact arriving after our stale-node sweep — applied as a no-op. A reattest for a row we never
 * held is a hole, and stops.
 */
async function projectPresenceEvent(
  db: Driver,
  teamId: string,
  originNode: string,
  event: SyncPullLaneEvent['event'],
): Promise<'applied' | 'unborn' | 'unknown'> {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const presenceId = typeof d['presence'] === 'string' ? d['presence'] : '';
  if (!presenceId) return 'unknown';
  const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
  switch (event.action) {
    case 'presence.attached': {
      const surface = str('surface');
      if (!surface || !STORABLE_SURFACES.has(surface)) return 'unknown';
      const member = await getMemberByName(db, teamId, event.actor ?? '');
      if (!member) return 'unknown'; // the caller resolved the seat already; defensive
      // Two origins minting one presence id cannot happen (ULIDs); a held row here is a replay
      // that slipped the pair check, so keep ours.
      if (await db.get('SELECT 1 FROM presence WHERE id = ?', [presenceId])) return 'applied';
      const model = str('model');
      await db.run(
        `INSERT INTO presence (id, member_id, team_id, surface, status, conn_id, last_seen_at, held_until, provenance, workspace, driver, model, model_source, build, epoch, guidance_epoch, style_epoch, wake_lease, node, created_at)
         VALUES (?, ?, ?, ?, 'online', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          presenceId,
          member.id,
          member.team_id,
          surface,
          event.ts,
          str('provenance'),
          str('workspace'),
          str('driver'),
          model,
          model ? str('model_source') : null,
          str('build'),
          typeof d['epoch'] === 'number' ? d['epoch'] : null,
          // ADR 417. Folded like `epoch`: a remote seat's guidance epoch is a fact about THAT seat's
          // workspace, and a census that silently reads null for every replicated row would report the
          // rest of the fleet as unstamped rather than as unmeasured.
          typeof d['guidance_epoch'] === 'number' ? d['guidance_epoch'] : null,
          typeof d['style_epoch'] === 'string' ? d['style_epoch'] : null,
          originNode,
          event.ts,
        ],
      );
      return 'applied';
    }
    case 'presence.detached':
      await db.run('DELETE FROM presence WHERE id = ? AND node = ?', [presenceId, originNode]);
      return 'applied';
    case 'presence.reattested': {
      const surface = str('surface');
      if (surface && !STORABLE_SURFACES.has(surface)) return 'unknown';
      const model = str('model');
      const r = await db.run(
        'UPDATE presence SET model = ?, model_source = ?, surface = COALESCE(?, surface), guidance_epoch = COALESCE(?, guidance_epoch), style_epoch = COALESCE(?, style_epoch) WHERE id = ? AND node = ?',
        [
          model,
          model ? str('model_source') : null,
          surface,
          // COALESCE, matching the origin's own rule: an origin that re-attested a model without
          // touching guidance sends null here, and null is "no change", not "forget what you knew".
          typeof d['guidance_epoch'] === 'number' ? d['guidance_epoch'] : null,
          typeof d['style_epoch'] === 'string' ? d['style_epoch'] : null,
          presenceId,
          originNode,
        ],
      );
      return r.changes === 0 ? 'unborn' : 'applied';
    }
    default:
      return 'unknown';
  }
}

/** The pull response's `nodes` summary, applied before the events it accompanies (spec §3). */
export async function foldNodeLiveness(
  db: Driver,
  teamId: string,
  nodes: { id: string; label: string; last_seen_at: number | null }[],
): Promise<void> {
  // Safe for the local node too: `upsertForeignNode` touches only label and last_seen_at.
  for (const n of nodes) await upsertForeignNode(db, teamId, n);
}

export interface FoldResult {
  applied: number;
  skipped: number;
  /** The cursor after this call — the last hub_seq applied or skipped. */
  last_hub_seq: number;
  stop: FoldStop | null;
  /**
   * The ids of the messages this call inserted, in fold order — the hub's route-time hooks that a
   * folded message must still fire (the incident pool, ADR 371 §2) run from this list, never from a
   * re-scan of `messages`, which would re-fire them on every tick.
   */
  messages: string[];
  /**
   * Seed-thread entries this call held rather than projected, because their seed is not here (ADR
   * 500). Not a stop: the pull logs them so a seed that never arrives is still findable.
   */
  held_seed_threads: { relay_id: string; hub_seq: number }[];
  /**
   * ADR 525: member ids this call HALTED. The fold sets the standing and revokes leases inside its
   * transaction; evicting a live WebSocket needs the connection hub, so the pull does that after.
   */
  halted: string[];
}

export async function readPullCursor(db: Driver, teamId: string): Promise<number> {
  return (
    (
      await db.get<{ last_hub_seq: number }>(
        'SELECT last_hub_seq FROM sync_pull_cursor WHERE team_id = ?',
        [teamId],
      )
    )?.last_hub_seq ?? 0
  );
}

/**
 * ADR 393: `residency.enrolled` / `residency.revoked` project into the `residency` table so the
 * roster can tell the truth. The standing grant never crosses. `session_captured` sets the
 * resumable stamp when a row is already here; missing the row is a no-op, as on the origin.
 * An unknown seat on enroll/revoke is git lag — stop, don't skip.
 */
async function projectResidencyLedger(
  db: Driver,
  teamId: string,
  e: {
    action: string;
    target: string | null;
    actor: string | null;
    ts: number;
    detail: Record<string, unknown> | null;
  },
  hubSeq: number,
): Promise<{ stop?: FoldStop }> {
  if (
    e.action !== 'residency.enrolled' &&
    e.action !== 'residency.revoked' &&
    e.action !== 'residency.session_captured' &&
    e.action !== 'residency.host_seen'
  ) {
    return {};
  }
  if (e.action === 'residency.host_seen') return {};
  if (e.action === 'residency.session_captured') {
    const seat = await getMemberByName(db, teamId, e.target ?? '');
    const harness = typeof e.detail?.['harness'] === 'string' ? e.detail['harness'] : '';
    if (seat && harness) await recordSessionAttestation(db, teamId, seat.id, harness, e.ts);
    return {};
  }
  const seatName = e.target ?? '';
  const member = await getMemberByName(db, teamId, seatName);
  if (!member) {
    return { stop: { kind: 'unresolved_seat', seat: seatName, hub_seq: hubSeq } };
  }
  if (e.action === 'residency.revoked') {
    await revokeResidency(db, teamId, member.id);
    return {};
  }
  const harness = typeof e.detail?.['harness'] === 'string' ? e.detail['harness'] : '';
  const host = typeof e.detail?.['host'] === 'string' ? e.detail['host'] : '';
  if (!harness || !host) return {};
  const authorized =
    typeof e.detail?.['authorized_by'] === 'string' ? e.detail['authorized_by'] : (e.actor ?? null);
  const policyRaw = e.detail?.['policy'];
  const policy =
    policyRaw && typeof policyRaw === 'object' && !Array.isArray(policyRaw)
      ? (policyRaw as Record<string, unknown>)
      : undefined;
  await applyFoldedEnrollment(db, teamId, {
    member_id: member.id,
    harness,
    host,
    authorized_by: authorized,
    ...(policy !== undefined ? { policy } : {}),
  });
  return {};
}

/**
 * ADR 689: a sponsor-scoped credential the hub accepted projects into this daemon's
 * `agent_bootstrap_credentials`, so a hub-minted sponsor host key authenticates here. Only a
 * row from another node projects (this daemon's own mint already inserted it); the hash is a
 * verifier of a 192-bit secret, never a bearer (ADR 689 decision 9). `revoked` ends it.
 */
async function projectCredentialLedger(
  db: Driver,
  teamId: string,
  e: { action: string; target: string | null; detail: Record<string, unknown> | null },
  originNode: string,
  localNode: string | null,
): Promise<void> {
  if (e.action !== 'credential.accepted' && e.action !== 'credential.revoked') return;
  if (localNode !== null && originNode === localNode) return;
  const id = e.target ?? '';
  if (!id) return;
  if (e.action === 'credential.revoked') {
    await db.run(
      `UPDATE agent_bootstrap_credentials SET state = 'revoked', revoked_at = ?
       WHERE id = ? AND team_id = ? AND state IN ('active', 'rotated')`,
      [Date.now(), id, teamId],
    );
    return;
  }
  const d = e.detail ?? {};
  // A request's acceptance (`requested_from` set) is a record: the credential lives only where it
  // was minted, and no other node — the hub included — holds it as a bearer.
  if (typeof d['requested_from'] === 'string') return;
  const use = d['use'];
  const target = d['target'];
  const keyHash = d['key_hash'];
  if ((use !== 'host' && use !== 'claim_seat') || typeof target !== 'string') return;
  if (typeof keyHash !== 'string' || !keyHash) return;
  await db.run(
    `INSERT INTO agent_bootstrap_credentials
      (id, team_id, key_hash, use_kind, target, label, state, expires_at, created_by, created_at, rotated_at, revoked_at, replicated_from)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      id,
      teamId,
      keyHash,
      use,
      target,
      typeof d['label'] === 'string' ? d['label'] : null,
      typeof d['expires_at'] === 'number' ? d['expires_at'] : null,
      typeof d['sponsor'] === 'string' ? d['sponsor'] : null,
      typeof d['created_at'] === 'number' ? d['created_at'] : Date.now(),
      originNode,
    ],
  );
}

/**
 * ADR 689 decision 3: provisions cross. At a joiner, the hub's `pending` (pinned to a label) and
 * `cancelled` project into `host_provisions`; at the hub, a joiner's `claimed` / `ready` /
 * `failed` — host-actor rows ingest has already bound to the pushing node — move the hub's own row,
 * and only where its state and claimant agree. A pending row naming a seat or sponsor this roster
 * lacks is git lag: stop, don't skip.
 */
async function projectProvisionLedger(
  db: Driver,
  teamId: string,
  e: {
    action: string;
    target: string | null;
    actor: string | null;
    ts: number;
    detail: Record<string, unknown> | null;
  },
  hubSeq: number,
  originNode: string,
): Promise<{ stop?: FoldStop }> {
  if (!e.action.startsWith('host.provision_')) return {};
  const id = e.target ?? '';
  if (!id) return {};
  const d = e.detail ?? {};
  const team = await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]);
  if (!team) return {};
  const joiner = (await joinerEnrollment(db, teamId, team.slug)) !== null;
  if (joiner) {
    if (e.action === 'host.provision_pending') {
      const host = typeof d['host'] === 'string' ? d['host'] : null;
      if (!host) return {};
      const agentName = typeof d['agent'] === 'string' ? d['agent'] : '';
      const sponsorName = typeof d['sponsor'] === 'string' ? d['sponsor'] : '';
      const agent = await getMemberByName(db, teamId, agentName);
      if (!agent) return { stop: { kind: 'unresolved_seat', seat: agentName, hub_seq: hubSeq } };
      const sponsor = await getMemberByName(db, teamId, sponsorName);
      if (!sponsor)
        return { stop: { kind: 'unresolved_seat', seat: sponsorName, hub_seq: hubSeq } };
      const kind = d['kind'] === 'move' ? 'move' : 'mint';
      const moveJson =
        kind === 'move' && d['move'] !== null && typeof d['move'] === 'object'
          ? JSON.stringify(d['move'])
          : null;
      await db.run(
        `INSERT INTO host_provisions
           (id, team_id, member_id, sponsor_id, host, state, connect_origin, created_at, kind, move_json)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [
          id,
          teamId,
          agent.id,
          sponsor.id,
          host,
          typeof d['connect_origin'] === 'string' ? d['connect_origin'] : null,
          typeof d['created_at'] === 'number' ? d['created_at'] : e.ts,
          kind,
          moveJson,
        ],
      );
    } else if (e.action === 'host.provision_cancelled') {
      await db.run(
        "UPDATE host_provisions SET state = 'cancelled' WHERE id = ? AND team_id = ? AND state = 'pending'",
        [id, teamId],
      );
    }
    return {};
  }
  if (d['actor_kind'] !== 'host' || !e.actor) return {};
  const label = e.actor;
  if (!(await hostBoundTo(db, teamId, label, originNode))) return {};
  if (e.action === 'host.provision_claimed') {
    await db.run(
      `UPDATE host_provisions SET state = 'claimed', claimed_by = ?, claimed_at = ?
        WHERE id = ? AND team_id = ? AND state = 'pending' AND host = ?`,
      [label, e.ts, id, teamId, label],
    );
  } else if (e.action === 'host.provision_ready') {
    await db.run(
      `UPDATE host_provisions SET state = 'ready', ready_at = ?
        WHERE id = ? AND team_id = ? AND state = 'claimed' AND claimed_by = ?`,
      [e.ts, id, teamId, label],
    );
  } else if (e.action === 'host.provision_failed') {
    await db.run(
      `UPDATE host_provisions SET state = 'failed', failed_reason = ?
        WHERE id = ? AND team_id = ? AND state IN ('pending', 'claimed') AND (claimed_by = ? OR host = ?)`,
      [typeof d['reason'] === 'string' ? d['reason'] : 'failed', id, teamId, label, label],
    );
  }
  return {};
}

/**
 * ADR 689 decision 3: a joiner's host heartbeat lands in the hub's `host_liveness` — the hub
 * only, for a label this hub minted a live host key for (ingest has already bound the label to
 * the pushing node). The sponsor is resolved by name here; a heartbeat for a label the hub does
 * not know is ignored, never a stop.
 */
async function projectHostHeartbeat(
  db: Driver,
  teamId: string,
  e: {
    target: string | null;
    actor: string | null;
    ts: number;
    detail: Record<string, unknown> | null;
  },
  originNode: string,
  now: number,
): Promise<void> {
  const host = e.target ?? '';
  if (!host || e.actor !== host || e.detail?.['actor_kind'] !== 'host') return;
  const team = await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]);
  if (!team || (await joinerEnrollment(db, teamId, team.slug)) !== null) return;
  if (!(await hostBoundTo(db, teamId, host, originNode))) return;
  // The sponsor is the live host key's creator on THIS daemon's rows, never the row's say-so.
  const key = await db.get<{ created_by: string | null }>(
    `SELECT created_by FROM agent_bootstrap_credentials
      WHERE team_id = ? AND use_kind = 'host' AND target = ? AND state = 'active'
        AND replicated_from IS NULL ORDER BY created_at DESC LIMIT 1`,
    [teamId, host],
  );
  const sponsor = key?.created_by ? await getMemberByName(db, teamId, key.created_by) : undefined;
  // A heartbeat is "seen now", never a time the pusher chose.
  await recordHostSeen(db, teamId, host, Math.min(e.ts, now), sponsor?.id ?? null);
}

/**
 * ADR 689 decision 5 at fold time: is `host` a label this hub minted a live key for, bound to
 * `originNode`? Ingest bound it; the fold re-checks rather than trusting the row's tag, so a row
 * that reached the log some other way moves nothing.
 */
async function hostBoundTo(
  db: Driver,
  teamId: string,
  host: string,
  originNode: string,
): Promise<boolean> {
  if (!(await isLiveHostLabel(db, teamId, host))) return false;
  const bound = await db.get<{ node: string | null }>(
    'SELECT node FROM host_liveness WHERE team_id = ? AND host = ?',
    [teamId, host],
  );
  return bound?.node === originNode;
}

/**
 * ADR 689 decision 6, the hub's half: a joiner's `credential.minted` is a request. The hub checks,
 * at fold time and against its own current rows, that the minting host key is live and minted
 * here, sponsor-scoped to the named sponsor who still stands and may still sponsor, that the
 * target is that sponsor's live agent, and that the request came from the node the label is
 * bound to. It then RECORDS its own `credential.accepted` (`requested_from` = the requesting
 * node) — never inserting a bearer from a pushed row; the credential authenticates only where it
 * was minted — or `credential.refused` with the reason. A joiner folding a relayed request does nothing — only
 * the hub answers.
 */
async function answerCredentialRequest(
  db: Driver,
  teamId: string,
  e: {
    action: string;
    target: string | null;
    actor: string | null;
    detail: Record<string, unknown> | null;
  },
  originNode: string,
  localNode: string | null,
): Promise<void> {
  if (e.action !== 'credential.minted') return;
  if (localNode !== null && originNode === localNode) return;
  const team = await db.get<{ slug: string }>('SELECT slug FROM teams WHERE id = ?', [teamId]);
  if (!team || (await joinerEnrollment(db, teamId, team.slug)) !== null) return;
  const id = e.target ?? '';
  const d = e.detail ?? {};
  const host = typeof d['host'] === 'string' ? d['host'] : '';
  const sponsorName = typeof d['sponsor'] === 'string' ? d['sponsor'] : '';
  const target = typeof d['target'] === 'string' ? d['target'] : '';
  const keyHash = typeof d['key_hash'] === 'string' ? d['key_hash'] : '';
  const refuse = async (reason: string) => {
    await appendAudit(db, teamId, {
      actor: null,
      action: 'credential.refused',
      target: id,
      result: 'deny',
      detail: { reason, host, sponsor: sponsorName, target, origin_node: originNode },
    });
  };
  if (!id || !host || !sponsorName || !target || !keyHash || d['use'] !== 'claim_seat') {
    await refuse('malformed');
    return;
  }
  if (e.actor !== host || d['actor_kind'] !== 'host') {
    await refuse('actor_not_host');
    return;
  }
  const bound = await db.get<{ node: string | null }>(
    'SELECT node FROM host_liveness WHERE team_id = ? AND host = ?',
    [teamId, host],
  );
  if (bound?.node !== originNode) {
    await refuse('host_not_bound_to_origin');
    return;
  }
  const hostKey = await db.get<{
    id: string;
    created_by: string | null;
    replicated_from: string | null;
    expires_at: number | null;
  }>(
    `SELECT id, created_by, replicated_from, expires_at FROM agent_bootstrap_credentials
      WHERE team_id = ? AND use_kind = 'host' AND target = ? AND state = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [teamId, host],
  );
  if (!hostKey || hostKey.replicated_from !== null) {
    await refuse('no_live_host_key');
    return;
  }
  if (hostKey.expires_at !== null && hostKey.expires_at <= Date.now()) {
    await refuse('host_key_expired');
    return;
  }
  if (hostKey.created_by !== sponsorName) {
    await refuse('host_key_not_sponsors');
    return;
  }
  const sponsor = await getMemberByName(db, teamId, sponsorName);
  if (!sponsor || sponsor.left_at !== null) {
    await refuse('sponsor_gone');
    return;
  }
  try {
    assertSponsorCaller(sponsor);
  } catch {
    await refuse('sponsor_standing');
    return;
  }
  const agent = await getMemberByName(db, teamId, target);
  if (!agent || agent.left_at !== null || agent.sponsored_by !== sponsor.id) {
    await refuse('target_not_sponsored');
    return;
  }
  // The hub RECORDS the acceptance; it never inserts a bearer from a pushed row. A seat
  // credential authenticates only at the node that minted it — a row here would let an enrolled
  // machine that squatted the label mint a credential usable AT THE HUB. An id this hub already
  // holds is a collision, not a request.
  if (
    await db.get('SELECT id FROM agent_bootstrap_credentials WHERE id = ? AND team_id = ?', [
      id,
      teamId,
    ])
  ) {
    await refuse('id_collision');
    return;
  }
  await appendAudit(db, teamId, {
    actor: null,
    action: 'credential.accepted',
    target: id,
    result: 'allow',
    detail: {
      use: 'claim_seat',
      target,
      sponsor: sponsorName,
      host,
      key_hash: keyHash,
      expires_at: typeof d['expires_at'] === 'number' ? d['expires_at'] : null,
      created_at: typeof d['created_at'] === 'number' ? d['created_at'] : Date.now(),
      ...(typeof d['label'] === 'string' ? { label: d['label'] } : {}),
      requested_from: originNode,
    },
  });
}

async function writePullCursor(
  db: Driver,
  teamId: string,
  hubSeq: number,
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO sync_pull_cursor (team_id, last_hub_seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET last_hub_seq = excluded.last_hub_seq, updated_at = excluded.updated_at`,
    [teamId, hubSeq, now],
  );
}

async function localNodeId(db: Driver, teamId: string): Promise<string | null> {
  return (
    (
      await db.get<{ node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?', [
        teamId,
      ])
    )?.node_id ?? null
  );
}

/**
 * The highest origin_seq this daemon holds for an origin — the read-side gap check's baseline.
 * Across BOTH replicated kinds: one allocator serves messages and lane rows (ADR 335 §8), so a head
 * read from one table alone under-reports and trips the gap check on a legitimate sequence.
 */
/**
 * The audit legs of the held-set reads, exported for the plan assert in db.test.ts. `origin_seq > 0`
 * is not a filter — the wire never carries a non-positive seq — it is what lets SQLite use
 * `idx_audit_origin`, which is PARTIAL on exactly that predicate (v58): a query that does not prove
 * it gets no index and SCANs every audit row, local-only rows included. Both reads ran per folded
 * event, so a replay cost O(n²) in the replica's size: a fresh joiner's pages slowed from 1.4 s to
 * 7+ s each between hub_seq 50k and 70k, and past the hub's 5 s keep-alive window every page after
 * the first died on a closed socket (second-machine run, 2026-10-02).
 */
export const HELD_HEAD_AUDIT_SQL =
  'SELECT MAX(origin_seq) AS high FROM audit WHERE origin_node = ? AND origin_seq > 0';
export const HELD_PAIR_AUDIT_SQL =
  'SELECT id FROM audit WHERE origin_node = ? AND origin_seq = ? AND origin_seq > 0';

async function heldHead(db: Driver, originNode: string): Promise<number> {
  const m =
    (
      await db.get<{ high: number | null }>(
        'SELECT MAX(origin_seq) AS high FROM messages WHERE origin_node = ? AND origin_seq > 0',
        [originNode],
      )
    )?.high ?? 0;
  const a = (await db.get<{ high: number | null }>(HELD_HEAD_AUDIT_SQL, [originNode]))?.high ?? 0;
  return Math.max(m, a);
}

/** Rule 2 for both kinds: is the pair already held here? */
async function heldPair(db: Driver, originNode: string, originSeq: number): Promise<boolean> {
  return (
    (await db.get<{ id: string }>(
      'SELECT id FROM messages WHERE origin_node = ? AND origin_seq = ? AND origin_seq > 0',
      [originNode, originSeq],
    )) !== undefined ||
    (await db.get<{ id: string }>(HELD_PAIR_AUDIT_SQL, [originNode, originSeq])) !== undefined
  );
}

export async function foldBatch(
  db: Driver,
  teamId: string,
  events: SyncPullEvent[],
  now: number = Date.now(),
  /**
   * Where the log's lane history begins (`laneGenesis`), or `null` when the peer did not say. A
   * transition for a lane older than this needs no birth to wait for — see the `lane_unborn`
   * branch. `null` keeps the pre-2026-09-04 behaviour: block on every unborn lane.
   */
  laneGenesis: string | null = null,
): Promise<FoldResult> {
  return db.tx(async (t): Promise<FoldResult> => {
    const local = await localNodeId(t, teamId);
    const startCursor = await readPullCursor(t, teamId);
    let cursor = startCursor;
    let applied = 0;
    let skipped = 0;
    let stop: FoldStop | null = null;
    const messages: string[] = [];
    const heldSeedThreads: { relay_id: string; hub_seq: number }[] = [];

    // A `return finish()` inside t.transaction COMMITS what ran before it: the prefix and the
    // cursor go together. Only an unclassified throw rolls the batch back.
    const halted: string[] = [];
    const finish = async (): Promise<FoldResult> => {
      if (cursor !== startCursor) await writePullCursor(t, teamId, cursor, now);
      return {
        applied,
        skipped,
        last_hub_seq: cursor,
        stop,
        messages,
        held_seed_threads: heldSeedThreads,
        halted,
      };
    };

    for (const event of events) {
      // Rule 1 — own origin: already here via insertMessage / the store's lane write. Not an error.
      if (local !== null && event.origin_node === local) {
        skipped += 1;
        cursor = event.hub_seq;
        continue;
      }

      // Rule 2 — replay: the pair is the idempotence key, whichever kind holds it.
      if (await heldPair(t, event.origin_node, event.origin_seq)) {
        skipped += 1;
        cursor = event.hub_seq;
        continue;
      }

      // Read-side gap: the hub ingests gaplessly and we walk hub_seq in order, so this cannot trip
      // unless the hub's own invariant broke. Terminal — it is that invariant's falsifier from here.
      const expected = (await heldHead(t, event.origin_node)) + 1;
      if (event.origin_seq !== expected) {
        stop = {
          kind: 'origin_gap',
          origin: event.origin_node,
          expected,
          got: event.origin_seq,
          hub_seq: event.hub_seq,
        };
        return await finish();
      }

      // The fourth kind: a ledger row (ADR 365). Held in `audit` with its stamp, projected into
      // nothing — the ledger IS the projection, and `deriveWakeMetrics` reads it there. No seat
      // resolution: an audit row's `actor` is text, not a foreign key, so a seat this roster lacks
      // costs nothing and blocking on it would stall the ledger behind git lag.
      if (event.kind === 'ledger') {
        const e = event.event;
        // A projected verb (`lane.*`, `presence.*`) wearing the ledger tag is a smuggled transition
        // — UNLESS the verb is declared a ledger row by name. `presence.session_ended` is one
        // (ADR 371 §4, ADR 164's rung dataset): the first `musterd halt` (ADR 501, 2026-10-03)
        // staged it under the ledger tag it is declared with, and this guard — written for the
        // prefix alone — wedged every joiner at that row (lane 01M41QG1HY). The declaration set
        // is the one `appendAudit` stages by, so the two cannot drift again.
        if (
          (e.action.startsWith('lane.') || e.action.startsWith('presence.')) &&
          !REPLICATED_LEDGER_VERBS.has(e.action)
        ) {
          stop = { kind: 'mistagged_ledger_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        const projected = await projectResidencyLedger(t, teamId, e, event.hub_seq);
        if (projected.stop) {
          stop = projected.stop;
          return await finish();
        }
        await projectCredentialLedger(t, teamId, e, event.origin_node, local);
        await answerCredentialRequest(t, teamId, e, event.origin_node, local);
        if (e.action === 'residency.host_seen' && !(local !== null && event.origin_node === local))
          await projectHostHeartbeat(t, teamId, e, event.origin_node, now);
        const provisioned = await projectProvisionLedger(
          t,
          teamId,
          e,
          event.hub_seq,
          event.origin_node,
        );
        if (provisioned.stop) {
          stop = provisioned.stop;
          return await finish();
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The policy kind: a policy change (residence-2 census gap 1). Held in `audit` with its
      // stamp, then projected into `teams.policy` in the same transaction — the same discipline as
      // the lane and presence kinds. No seat resolution: the actor is an admin on the HUB's roster
      // and may not be a member here at all, and the fact is about the team, not about a seat.
      if (event.kind === 'policy') {
        const e = event.event;
        if (!POLICY_VERBS.has(e.action)) {
          stop = { kind: 'unknown_policy_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        if ((await projectPolicyEvent(t, teamId, e, now, halted)) === 'unknown') {
          stop = { kind: 'unknown_policy_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The sixth kind: a record (ADR 371, residence-2 census gap 3) — a tool-call batch, a seed
      // thread entry, or the hub's incident pool row. Project first, then hold the row in `audit`
      // with its stamp, the discipline every projecting kind follows. The seed thread names a
      // member and must resolve it here (git lag otherwise); the other two key on seat NAMES and
      // resolve nothing, as the ledger kind does.
      if (event.kind === 'record') {
        const e = event.event;
        if (!RECORD_VERBS.has(e.action)) {
          stop = { kind: 'unknown_record_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        let memberId: string | null = null;
        if (e.action === 'record.seed_thread') {
          const by = e.detail?.['by'];
          const member = await getMemberByName(
            t,
            teamId,
            typeof by === 'string' ? by : (e.actor ?? ''),
          );
          if (!member) {
            stop = {
              kind: 'unresolved_seat',
              seat: typeof by === 'string' ? by : (e.actor ?? ''),
              hub_seq: event.hub_seq,
            };
            return await finish();
          }
          memberId = member.id;
        }
        const outcome = await projectRecordEvent(t, teamId, e, memberId);
        if (outcome === 'unknown') {
          stop = { kind: 'unknown_record_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        // ADR 500: an entry whose seed is not here is HELD, not a stop. Its audit row lands below
        // like any other, and `projectHeldThreads` projects it from there on the seed's birth. A
        // seed captured before ADR 399 has no birth in the log at all, so a stop here waited forever
        // — Air 2 wedged at hub_seq 147,019 on 31 such seeds (2026-10-02).
        if (outcome === 'seed_unborn') {
          const relayId = e.detail?.['relay_id'];
          heldSeedThreads.push({
            relay_id: typeof relayId === 'string' ? relayId : '',
            hub_seq: event.hub_seq,
          });
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The fifth kind: a seat's continuity — its memory note and its inbox cursor (residence-2
      // census gap 2). Seat facts, so the seat must resolve here before anything is projected: an
      // unknown name is git lag, the same rule the message and presence kinds follow.
      if (event.kind === 'continuity') {
        const e = event.event;
        if (!CONTINUITY_VERBS.has(e.action)) {
          stop = { kind: 'unknown_continuity_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        const seat = await getMemberByName(t, teamId, e.actor ?? '');
        if (!seat) {
          stop = { kind: 'unresolved_seat', seat: e.actor ?? '', hub_seq: event.hub_seq };
          return await finish();
        }
        // Project first, so a stop lands BEFORE the audit row does — a row present for an event
        // this daemon never applied would advance heldHead past it.
        const outcome = await projectContinuityEvent(t, teamId, seat, e, now);
        if (outcome === 'unknown') {
          stop = { kind: 'unknown_continuity_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        if (outcome === 'cursor_unborn') {
          const messageId = e.detail?.['last_read_message_id'];
          stop = {
            kind: 'cursor_unborn',
            message: typeof messageId === 'string' ? messageId : '',
            seat: seat.name,
            hub_seq: event.hub_seq,
          };
          return await finish();
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The third kind: a presence transition. Same discipline as the lane kind — project first,
      // then hold the row in `audit` with its stamp — plus the message rule for the seat: a
      // presence for a seat this roster lacks is git lag, not a fact to drop.
      if (event.kind === 'presence') {
        const e = event.event;
        if (!PRESENCE_VERBS.has(e.action)) {
          stop = { kind: 'unknown_presence_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        // THE PRESENCE KIND NEVER BLOCKS THE FOLD (ADR 384, superseding ADR 382's narrower rule).
        // Every other kind may stop, because every other kind decides something here: an inbox
        // counts a message, a board shows a lane. Presence on a peer paints no roster line and gates
        // no claim — ADR 325 keeps it local-only and replicates transitions only as a summary — so a
        // presence event that cannot project decides nothing, and blocking on one trades a fact
        // worth nothing for a fold worth nothing. That is the ledger's carve-out (ADR 365), applied
        // to the kind it fits best.
        //
        // Both unprojectable shapes arise in the ordinary course, not only in a corrupt log:
        //   - the seat is not on this roster — a web sign-in, minted db-only, which git never
        //     carries (one stopped the first real joiner dead at hub_seq 9657, 2026-09-04);
        //   - the session has no row — this daemon's OWN reaper took it. A joiner replaying a
        //     backlog folds an attach, sweeps the row minutes later, then meets the re-attestation
        //     hours behind and waits forever on a row it deleted itself (hub_seq 9659, same joiner,
        //     with hundreds of sessions queued behind it).
        // Nothing is invented either way: a re-attestation carries partial facets, so a row built
        // from one would be a lie with a schema. The audit row below still lands, so the transition
        // is kept as evidence. One presence stop survives, below: a build too old to store the fact.
        if (await getMemberByName(t, teamId, e.actor ?? '')) {
          // `unknown` is the one presence stop that stays: a verb or surface this build cannot
          // store means the ORIGIN runs a newer build, which is transient and fixed by upgrading —
          // the same reason `unknown_lane_event` and `unknown_record_event` block. It is the
          // never-arrives cases that must not.
          if ((await projectPresenceEvent(t, teamId, event.origin_node, e)) === 'unknown') {
            stop = { kind: 'unknown_presence_event', action: e.action, hub_seq: event.hub_seq };
            return await finish();
          }
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      // The second kind: a lane transition. Held in `audit` with its stamp verbatim, then projected
      // into `lanes` in this same transaction — the fold is the one foreign writer of both.
      if (event.kind === 'seed') {
        const e = event.event;
        if (!SEED_VERBS.has(e.action)) {
          stop = { kind: 'unknown_seed_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        // The submitter names a seat, resolved HERE — `members.id` is daemon-private, so the event
        // carries the name, as every seat-fact kind does. Unresolved is git lag, not a hole.
        const by = e.detail?.['by'];
        const name = typeof by === 'string' ? by : (e.actor ?? '');
        const member = await getMemberByName(t, teamId, name);
        if (!member) {
          stop = { kind: 'unresolved_seat', seat: name, hub_seq: event.hub_seq };
          return await finish();
        }
        const outcome = await projectSeedEvent(t, teamId, e, member.id, now);
        if (outcome === 'unknown') {
          stop = { kind: 'unknown_seed_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      if (event.kind === 'lane') {
        const e = event.event;
        if (!LANE_VERBS.has(e.action)) {
          stop = { kind: 'unknown_lane_event', action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        // A field this build has no column for belongs to a newer peer. Stop BEFORE anything of the
        // event is applied: the rest would land, the event would count as applied, and the field
        // would be gone for good once this daemon upgraded. Retried each tick, like an unknown verb.
        const unmapped = e.action === 'lane.updated' ? unmappedLaneFields(e.detail) : [];
        if (unmapped.length > 0) {
          stop = {
            kind: 'unknown_lane_event',
            action: `lane.updated:${unmapped.join(',')}`,
            hub_seq: event.hub_seq,
          };
          return await finish();
        }
        const laneId =
          (typeof e.detail?.['lane'] === 'string' ? (e.detail['lane'] as string) : e.target) ?? '';
        // Project first: an unborn lane must stop BEFORE the audit row lands, or the row's presence
        // would advance heldHead past an event this daemon never applied.
        const outcome = await projectLaneEvent(t, teamId, e);
        // A lane older than the log's first `lane.opened` has no birth anywhere to wait for: the
        // log contains none for anything older, by construction (ULIDs sort by birth time). Waiting
        // is waiting forever — which is precisely how the first real joiner wedged, 9,393 events in.
        // So it advances: no `lanes` row is invented (a row with no title would be worse than none),
        // the audit row below still lands, and the transition stays findable in the trail. Every
        // other unborn lane still blocks, because there the birth may yet arrive or a hole is real.
        const preHistory =
          outcome === 'unborn' && laneGenesis !== null && laneId !== '' && laneId < laneGenesis;
        if (outcome === 'unborn' && !preHistory) {
          stop = { kind: 'lane_unborn', lane: laneId, action: e.action, hub_seq: event.hub_seq };
          return await finish();
        }
        await t.run(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq, actor_model, actor_model_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.id,
            teamId,
            e.ts,
            e.actor,
            e.action,
            e.target,
            e.result,
            e.detail ? JSON.stringify(e.detail) : null,
            now,
            event.origin_node,
            event.origin_seq,
            // The origin's stamp (lane 01M2PAFNAS): it saw the actor's model; this node may not.
            e.actor_model ?? null,
            e.actor_model && isWireAttestationSource(e.actor_model_source)
              ? e.actor_model_source
              : null,
          ],
        );
        applied += 1;
        cursor = event.hub_seq;
        continue;
      }

      const env = event.envelope;

      // Rule 3 — resolve every seat the envelope names, or stop here. `to` blocks too: NULL would
      // silently turn a directed act into a broadcast.
      const from =
        (await getMemberByName(t, teamId, env.from)) ??
        (await hostSeatFromEnvelope(t, teamId, env)) ??
        (await daemonServiceSeatFromName(t, teamId, env.from));
      if (!from) {
        stop = { kind: 'unresolved_seat', seat: env.from, hub_seq: event.hub_seq };
        return await finish();
      }
      let toMember: string | null = null;
      if (env.to.kind === 'member') {
        const to =
          (await getMemberByName(t, teamId, env.to.name)) ??
          (await daemonServiceSeatFromName(t, teamId, env.to.name));
        if (!to) {
          stop = { kind: 'unresolved_seat', seat: env.to.name, hub_seq: event.hub_seq };
          return await finish();
        }
        toMember = to.id;
      }

      // Rule 5 — the id is held under a different pair (rule 2 passed, so it is not a replay).
      const collision = await t.get<{ origin_node: string }>(
        'SELECT origin_node FROM messages WHERE id = ?',
        [env.id],
      );
      if (collision) {
        stop = {
          kind: 'id_collision',
          id: env.id,
          hub_seq: event.hub_seq,
          held_origin: collision.origin_node,
        };
        return await finish();
      }

      // Unknown act — the wire outran the reader: the origin runs a newer build. messages.act
      // carries no CHECK (dropped in the table rewrite), so the schema would happily store it and
      // every reader downstream would meet an act it cannot classify. Block until this daemon is
      // upgraded; skipping would drop an event a peer considers sent.
      if (!ActSchema.safeParse(env.act).success) {
        stop = { kind: 'unknown_act', act: env.act, hub_seq: event.hub_seq };
        return await finish();
      }

      // Rule 4 — insert with the origin stamp verbatim. NEVER reads or writes nodes.next_seq.
      const row: MessageRow = {
        id: env.id,
        team_id: teamId,
        from_member: from.id,
        to_kind: env.to.kind,
        to_member: toMember,
        act: env.act,
        body: env.body,
        thread_id: env.thread ?? null,
        meta: env.meta ? JSON.stringify(env.meta) : null,
        from_provenance: event.from_provenance,
        origin_node: event.origin_node,
        origin_seq: event.origin_seq,
        ts: env.ts,
        created_at: now,
      };
      await t.run(
        `INSERT INTO messages
           (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, from_provenance, origin_node, origin_seq, ts, created_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.team_id,
          row.from_member,
          row.to_kind,
          row.to_member,
          row.act,
          row.body,
          row.thread_id,
          row.meta,
          row.from_provenance,
          row.origin_node,
          row.origin_seq,
          row.ts,
          row.created_at,
        ],
      );
      messages.push(row.id);
      applied += 1;
      cursor = event.hub_seq;
    }
    return await finish();
  });
}
