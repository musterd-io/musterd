import type {
  ActDelivery,
  WakeabilityFacts,
  Envelope,
  LoopEdge,
  Policy,
  Residency,
  ResidencyPolicy,
  ResidencyPolicyOverride,
  WakeContextPacket,
  WakeContextRequest,
  WakeDerivation,
  WakeLane,
  WakeOrder,
  Residence,
} from '@musterd/protocol';
import {
  WAKE_CONTEXT_BUDGET,
  dreamBlocker,
  eligibleOf,
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  lastWorkingDayEnd,
  ResidencyPolicyOverrideSchema,
  ResidencyPolicySchema,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { type AuditEntry, appendAudit } from './audit.js';
import { getCursor } from './cursors.js';
import { openDirectedLedger } from './delivery.js';
import { listInterruptCandidates } from './interruptCandidates.js';
import { getLane, listLanes } from './lanes.js';
import { getMemberById } from './members.js';
import { memoryEnvelope } from './memory.js';
import {
  deferrals,
  listTeamMessages,
  pendingInterrupts,
  raisedDeferrals,
  rowToEnvelope,
} from './messages.js';
import { hasLivePresence, listReclaimableMemberIds } from './presence.js';
import { type MemberRow, type MessageRow, parseWorkingHours } from './rows.js';
import { getPolicy, getTeamById } from './teams.js';
import { deriveContext } from './wakeContextBody.js';

/**
 * The wake ledger (ADR 131, increment 2). The daemon side of harness residency: enrollment rows
 * (which seats are wakeable, on which host, under whose authority) and **wake leases** — the stored
 * mutual-exclusion record for wake actuation. Leases follow the `requests` precedent (short TTL,
 * reaper-expired), because actuation needs correctness the best-effort audit log cannot bear; every
 * *rate-shaped* decision (cooldown, hourly cap, per-act attempt cap) is DERIVED from
 * `residency.woke`/`residency.wake_failed` audit rows (the `hasInterruptRaised` pattern), never
 * stored. The daemon orders wakes; it never spawns a process (`musterd host`, increment 3, acts).
 */

/** Lease TTL: a wake the host hasn't reported within this window re-becomes due (crash-safe).
 *  Mechanism, not owner policy — deliberately NOT a `ResidencyPolicySchema` knob. */
export const WAKE_LEASE_TTL_MS = 120_000;
/** The launch-default wake policy (increment 5): every rate gate — cooldown, hourly cap, attempt
 *  cap, lanes — now reads from the effective policy (team defaults ⊕ per-seat override), and the
 *  defaults live in ONE place, the protocol schema. */
export const WAKE_POLICY_DEFAULTS: ResidencyPolicy = ResidencyPolicySchema.parse({});
/** After a host defers a wake for a live local session, the seat derives no new lease for this
 *  window (increment 4's local-session guard) — else a working human generates a lease+defer pair
 *  every poll tick. Deferrals consume NO attempt/cooldown/hourly budget (they are neither
 *  `residency.woke` nor `residency.wake_failed`), so the act stays fully due afterwards. */
export const WAKE_DEFER_SNOOZE_MS = 5 * 60_000;
/** ADR 485: the ceiling on a backed-off local-session snooze. A deferral for a session open in the
 *  seat's workspace doubles the window per unchanged repeat (5 → 10 → 20 → 40 → 60 min), because a
 *  flat 5 min re-derived the same lease 142× in 12 h for one idle session (2026-09-29). One hour
 *  bounds how long an act can wait after that session finally closes. */
export const WAKE_DEFER_SNOOZE_CAP_MS = 60 * 60_000;
/** ADR 485: the deferral reasons that say "a human's session is open here". Only these back off —
 *  `host_unreachable` (ADR 236) and cannot-actuate (ADR 221) need the fast retry a just-woken host
 *  deserves, so they keep the flat base window. */
const LOCAL_SESSION_DEFER_REASONS: readonly string[] = [
  'local-session-live',
  'attended-session-open',
];
/** How many recent deferrals the streak read looks at — enough for the window to reach the cap. */
const DEFER_STREAK_SCAN = 16;
/** Lane 01M3QRYZM2: the deferral an actuator sends for an order it was stopped before starting
 *  (`launchctl kickstart -k` mid-poll). It says nothing about the seat — a fresh actuator is up
 *  within seconds — so it is the one deferral reason that does NOT snooze lease derivation. */
export const WAKE_DEFER_ACTUATOR_RESTART = 'actuator_restart';
/**
 * ADR 236: a gap between reaper ticks this long means the loop did not run — it was not merely late.
 * Six times `REAPER_INTERVAL_MS`: far above scheduler jitter or a long GC pause, far below the
 * 12–16 minute gaps a suspended host produces (measured across every overnight lease expiry in the
 * live ledger, against a 0.2–0.3 minute daytime cluster). The threshold discriminates a host that
 * reported a failure from a host that was not there — the first burns wake budget, the second must
 * not, or an act is retired before anyone could answer it.
 */
export const HOST_SUSPEND_GAP_MS = 90_000;
/**
 * ADR 236: the bound on deferring for an unreachable host, measured in HOST-AWAKE time since the
 * act's first lease — wall-clock elapsed minus every recorded suspension. Past this, an expiry burns
 * attempt budget again, so termination stays provable. Six hours of a host actually being up is far
 * more than the attempt cap needs (three attempts at the 30-minute cooldown fit in ninety minutes),
 * yet short enough that a genuinely broken host is still retired within a working day of uptime.
 */
export const WAKE_UNREACHABLE_CEILING_MS = 6 * 3_600_000;
/**
 * ADR 262: work-order re-spend breaker. Counts `residency.wake_failed` rows on that
 * (lane, edge), including reaper `lease_expired`. Successful `woke` / continuation
 * chaining does not count.
 */
export const WORK_ORDER_EDGE_BREAKER_N = 3;
/** Closed set: last failure on this edge is still true, so another lease cannot help. */
export const STILL_TRUE_WAKEABILITIES: readonly string[] = [
  'enrolled_dead_workspace',
  'not_enrolled',
];
/**
 * ADR 306: the ceiling on a SUCCEEDING continuation chain, per (lane, edge). The ADR 262 breaker
 * bounds failure; nothing bounded success, because `dueDispatchContinuationWorkOrders` re-derives a
 * candidate for every claimed/active owned lane on every poll, forever.
 *
 * This number is a JUDGMENT, not a measurement, and the ledger cannot currently improve it: every
 * chain in the corpus was truncated at three by the very cap ADR 306 removes, so the observation is
 * censored — no lane was ever permitted to run longer. Eight is comfortably above the three that
 * provably strangles real chains (measured 2026-08-21: two lanes dead at 3 wokes / 0 failures) and
 * low enough that a runaway costs single-digit sessions. The trip is a counted event, so the first
 * real one is visible; re-measure once trips exist. Deliberately not a policy knob yet — a knob
 * nobody can calibrate is worse than a constant that says why.
 */
export const WORK_ORDER_CONTINUATION_SUCCESS_CAP = 8;
/**
 * How far back the wake derivation scans for deferring `wait`s (ADR 211 §4). Matches the inbox
 * read's bound: past this a deferral stops suppressing, and the act becomes a wake reason again —
 * the pre-ADR-211 behaviour.
 *
 * Note this is the inverse of `WAKE_DEFER_SNOOZE_MS` above despite the shared word: that one is the
 * host's local-session guard, which suppresses a wake for a window and leaves the act fully due.
 * This one is the recipient's own decision to postpone one named act.
 */
const DEFERRAL_SCAN_LIMIT = 2000;

export interface ResidencyRow {
  id: string;
  team_id: string;
  member_id: string;
  harness: string;
  host: string;
  grant_id: string | null;
  authorized_by: string | null;
  policy: string | null;
  /** Harness class of the last session-capture attestation (v17, ADR 131 §5) — class only, never an id. */
  resumable_harness: string | null;
  /** When the seat last attested a capturable session (v17). Null until the first capture. */
  resumable_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WakeLeaseRow {
  id: string;
  team_id: string;
  member_id: string;
  /** Null on board-continuation work-orders (ADR 199). */
  act_id: string | null;
  /** Lane id for work-orders; used when act_id is null for exhaustion keys. */
  lane_id: string | null;
  host: string;
  lane: string;
  status: string;
  created_at: number;
  expires_at: number;
  /** Work-order board edge (ADR 262). Null on inbox wakes. */
  edge: string | null;
  /** Host exec ack via POST wake-progress (ADR 262). Null until stamped. */
  spawned_at: number | null;
}

/** Rate/exhaustion key: message id, or `lane:<id>` for board continuation (ADR 199). */
export function wakeExhaustionKey(
  actId: string | null | undefined,
  laneId?: string | null,
): string {
  if (actId) return actId;
  if (laneId) return `lane:${laneId}`;
  return '?';
}

/**
 * Parse a stored per-seat policy override — **leniently**: the write side validated strictly, so an
 * unparseable blob here is drift (a hand-edit, a downgrade), and the honest read is "no override"
 * rather than a wake pipeline that throws. `residency status` names the drift separately.
 */
export function parsePolicyOverride(raw: string | null): ResidencyPolicyOverride | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ResidencyPolicyOverrideSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The effective wake policy for one enrollment: launch defaults ⊕ team defaults ⊕ seat override
 * (ADR 131 §3). Team defaults arrive already default-filled (`getPolicy` parses with defaults);
 * the sparse override contributes only its explicitly-set keys.
 */
/**
 * The wake-policy defaults a seat starts from, before its own enrollment override: the team's
 * `residency` block — and, for a sponsored agent (ADR 463 §2), `agent_host.policy` on top, so the
 * team's hosted-agent budget and bounds apply to every seat a sponsor's host runs.
 */
export function seatWakeDefaults(
  policy: Pick<Policy, 'residency' | 'agent_host'>,
  member: { sponsored_by: string | null } | undefined,
): ResidencyPolicy {
  if (!member || member.sponsored_by === null) return policy.residency;
  const merged: ResidencyPolicy = { ...policy.residency };
  for (const [key, value] of Object.entries(policy.agent_host.policy)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export function effectiveWakePolicy(
  teamDefaults: ResidencyPolicy,
  storedOverride: string | null,
): ResidencyPolicy {
  const override = parsePolicyOverride(storedOverride);
  if (!override) return teamDefaults;
  const merged: ResidencyPolicy = { ...teamDefaults };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * Who may read an act's wake packet: its directed recipient, or a seat its eligible set names
 * (ADR 254). A huddle open naming 2–4 seats is team-addressed, and its eligible set is exactly what
 * convenes them (ADR 386) — refusing it woke every named seat to a pointer it could not read
 * (rehearsal 2026-10-01, huddle 01M3W9RMA5). A plain `@team` act stays refused: the packet carries
 * the whole thread, and a reader nobody named has no standing in it.
 */
function mayReadWakeAct(row: MessageRow, recipient: MemberRow): boolean {
  if (row.to_kind === 'member') return row.to_member === recipient.id;
  if (row.to_kind !== 'team') return false;
  const named = eligibleOf(JSON.parse(row.meta ?? '{}') as Record<string, unknown>);
  return named !== null && named.includes(recipient.name);
}

/**
 * Derive the bounded orientation packet for one recipient (ADR 209; v2 per ADR 430). It reads
 * canonical rows only and stores nothing. Bodies cross this seam *attributed and budgeted* — the
 * waking thread's recent acts, the recipient's own memory — under `context`; the audit that records
 * the read never carries them. An unauthorized target is indistinguishable from a missing one.
 */
export async function buildWakeContext(
  db: Driver,
  team: { id: string; slug: string },
  recipient: MemberRow,
  request: WakeContextRequest,
): Promise<WakeContextPacket> {
  if (request.act_id !== undefined) {
    const row = await db.get<MessageRow>('SELECT * FROM messages WHERE team_id = ? AND id = ?', [
      team.id,
      request.act_id,
    ]);
    if (!row || !mayReadWakeAct(row, recipient))
      throw new MusterdError('forbidden', 'forbidden wake context target');
    const threadId = row.thread_id ?? row.id;
    const meta = JSON.parse(row.meta ?? '{}') as {
      lane_handoff?: { lane?: string };
      lane_review?: { lane?: string };
    };
    const laneId = meta.lane_review?.lane ?? meta.lane_handoff?.lane;
    const lane = laneId ? await getLane(db, team.id, laneId, team.slug) : null;
    const counts = await db.get<{ participants: number; unread: number }>(
      `SELECT COUNT(DISTINCT from_member) AS participants,
                SUM(CASE WHEN to_member = ? THEN 1 ELSE 0 END) AS unread
           FROM messages WHERE team_id = ? AND (id = ? OR thread_id = ?)`,
      [recipient.id, team.id, row.id, threadId],
    );
    const memory = await memoryEnvelope(db, recipient.id);
    const kind = meta.lane_review ? 'review' : meta.lane_handoff ? 'handoff' : 'reply';
    const derived = await deriveContext(db, team, recipient, {
      threadId,
      ...(lane ? { laneId: lane.id } : {}),
    });
    return {
      version: 2,
      wake: { kind, act_id: row.id },
      objective: {
        action: kind === 'review' ? 'review' : kind === 'handoff' ? 'continue_lane' : 'reply',
      },
      state: {
        thread: {
          id: threadId,
          participant_count: counts?.participants ?? 0,
          unread_count: counts?.unread ?? 0,
          latest_act: row.act,
        },
        ...(lane
          ? {
              lane: {
                id: lane.id,
                state: lane.state,
                owner_seat: lane.owner_seat,
                ...(lane.branch ? { branch: lane.branch } : {}),
              },
            }
          : {}),
        ...(memory ? { memory } : {}),
      },
      context: derived.context,
      budget: { limit_bytes: WAKE_CONTEXT_BUDGET.limit_bytes, used_bytes: derived.used_bytes },
      // v2: only what did not fit — plus the branch, which is never in the packet.
      fetch: [...derived.fetch, ...(lane ? (['git_artifact'] as const) : [])],
      delivery: { requirement: 'portable', intended: 'fresh' },
    };
  }
  const lane = await getLane(db, team.id, request.lane_id!, team.slug);
  if (!lane || lane.owner_seat !== recipient.name)
    throw new MusterdError('forbidden', 'forbidden wake context target');
  const memory = await memoryEnvelope(db, recipient.id);
  const derived = await deriveContext(db, team, recipient, { laneId: lane.id });
  return {
    version: 2,
    wake: { kind: 'work_order', lane_id: lane.id },
    objective: { action: lane.state === 'claimed' ? 'begin_lane' : 'continue_lane' },
    state: {
      lane: {
        id: lane.id,
        state: lane.state,
        owner_seat: lane.owner_seat,
        ...(lane.branch ? { branch: lane.branch } : {}),
      },
      ...(memory ? { memory } : {}),
    },
    context: derived.context,
    budget: { limit_bytes: WAKE_CONTEXT_BUDGET.limit_bytes, used_bytes: derived.used_bytes },
    fetch: [...derived.fetch, 'git_artifact'],
    delivery: { requirement: 'portable', intended: 'fresh' },
  };
}

/** Project a stored enrollment to the public shape (seat name resolved by the caller-provided row). */
export function toResidency(row: ResidencyRow, teamSlug: string, seatName: string): Residency {
  return {
    id: row.id,
    team: teamSlug,
    seat: seatName,
    harness: row.harness,
    host: row.host,
    grant_id: row.grant_id,
    authorized_by: row.authorized_by,
    resumable_at: row.resumable_at,
    policy: parsePolicyOverride(row.policy),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Enroll a seat into residency — an **upsert** keyed on the member (one enrollment per seat, one
 * host per seat): re-enrolling moves the seat to the new host/harness/grant (last-enrolled-wins,
 * ADR 131 §4 — the displaced host is told it is not the actuator by simply deriving nothing).
 * Returns the row plus the previous enrollment (if any) so the route can revoke the superseded
 * grant and audit the host swap.
 */
export async function enrollResidency(
  db: Driver,
  teamId: string,
  input: {
    member_id: string;
    harness: string;
    host: string;
    grant_id: string | null;
    authorized_by: string | null;
    /** Sparse knob override (increment 5). `undefined` = preserve the existing override on a
     *  re-enroll (a drift-fixing `residency on` must not nuke tuning); an object = replace
     *  wholesale; `{}` = clear back to team defaults (stored as NULL, not `'{}'`). */
    policy?: Record<string, unknown>;
  },
): Promise<{ row: ResidencyRow; previous: ResidencyRow | null }> {
  const now = Date.now();
  const policyJson =
    input.policy === undefined
      ? undefined
      : Object.keys(input.policy).length === 0
        ? null
        : JSON.stringify(input.policy);
  const previous =
    (await db.get<ResidencyRow>('SELECT * FROM residency WHERE member_id = ?', [
      input.member_id,
    ])) ?? null;
  if (previous) {
    await db.run(
      `UPDATE residency SET harness = ?, host = ?, grant_id = ?, authorized_by = ?, policy = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.harness,
        input.host,
        input.grant_id,
        input.authorized_by,
        policyJson === undefined ? previous.policy : policyJson,
        now,
        previous.id,
      ],
    );
    const row = (await db.get<ResidencyRow>('SELECT * FROM residency WHERE id = ?', [
      previous.id,
    ]))!;
    return { row, previous };
  }
  const row: ResidencyRow = {
    id: ulid(),
    team_id: teamId,
    member_id: input.member_id,
    harness: input.harness,
    host: input.host,
    grant_id: input.grant_id,
    authorized_by: input.authorized_by,
    policy: policyJson ?? null,
    resumable_harness: null,
    resumable_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.run(
    `INSERT INTO residency (id, team_id, member_id, harness, host, grant_id, authorized_by, policy, resumable_harness, resumable_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.team_id,
      row.member_id,
      row.harness,
      row.host,
      row.grant_id,
      row.authorized_by,
      row.policy,
      row.resumable_harness,
      row.resumable_at,
      row.created_at,
      row.updated_at,
    ],
  );
  return { row, previous: null };
}

/**
 * Record a session-capture attestation (ADR 131 §5, increment 4) on the seat's enrollment row —
 * harness class + timestamp only; the daemon never sees an id or a path. Returns whether the seat
 * is enrolled (an unenrolled capture updates nothing but the caller still audits it). Only the
 * `start` event lands here — `end` is advisory and audit-only (resumability never depends on it).
 */
export async function recordSessionAttestation(
  db: Driver,
  teamId: string,
  memberId: string,
  harness: string,
  now = Date.now(),
): Promise<boolean> {
  const info = await db.run(
    `UPDATE residency SET resumable_harness = ?, resumable_at = ?
        WHERE team_id = ? AND member_id = ?`,
    [harness, now, teamId, memberId],
  );
  return info.changes > 0;
}

/** Revoke a seat's enrollment (the `residency off` kill switch). Returns the removed row, or null. */
export async function revokeResidency(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<ResidencyRow | null> {
  const row = await db.get<ResidencyRow>(
    'SELECT * FROM residency WHERE team_id = ? AND member_id = ?',
    [teamId, memberId],
  );
  if (!row) return null;
  await db.run('DELETE FROM residency WHERE id = ?', [row.id]);
  return row;
}

/**
 * Project a folded `residency.enrolled` (ADR 393). Same upsert as `enrollResidency`, except the
 * standing grant never crosses — grants are local secrets — so `grant_id` is left as it is on a
 * re-enroll (a hub that also enrolled this seat keeps its own grant) and null on a first insert.
 * Wake derivation still filters `host === this host`, so the hub holding the row does not become
 * the actuator.
 */
export async function applyFoldedEnrollment(
  db: Driver,
  teamId: string,
  input: {
    member_id: string;
    harness: string;
    host: string;
    authorized_by: string | null;
    policy?: Record<string, unknown>;
  },
  now = Date.now(),
): Promise<void> {
  const previous = await getResidency(db, teamId, input.member_id);
  if (previous) {
    const policyJson =
      input.policy === undefined
        ? previous.policy
        : Object.keys(input.policy).length === 0
          ? null
          : JSON.stringify(input.policy);
    await db.run(
      `UPDATE residency SET harness = ?, host = ?, authorized_by = ?, policy = ?, updated_at = ?
       WHERE id = ?`,
      [input.harness, input.host, input.authorized_by, policyJson, now, previous.id],
    );
    return;
  }
  await enrollResidency(db, teamId, {
    member_id: input.member_id,
    harness: input.harness,
    host: input.host,
    grant_id: null,
    authorized_by: input.authorized_by,
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  });
}

export async function getResidency(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<ResidencyRow | null> {
  return (
    (await db.get<ResidencyRow>('SELECT * FROM residency WHERE team_id = ? AND member_id = ?', [
      teamId,
      memberId,
    ])) ?? null
  );
}

export async function listResidency(db: Driver, teamId: string): Promise<ResidencyRow[]> {
  return await db.all<ResidencyRow>(
    'SELECT * FROM residency WHERE team_id = ? ORDER BY created_at ASC, id ASC',
    [teamId],
  );
}

/**
 * How long a host may go silent before its seats read `enrolled_host_stale` (ADR 357).
 *
 * ~~60 s — six missed 10 s polls~~ CORRECTED 2026-09-02 by the first live falsifier: the actuator
 * polls every 10 s only while IDLE. `pollHostOnce` is serial — an actuation suspends polling for
 * its whole verify window, and the first codex wake after #1197 went 94 s between requests
 * (15:50:02 → 15:51:36) while doing exactly what it should. At 60 s every enrolled seat read
 * `enrolled_host_stale` during a healthy wake. Five minutes is above the longest silence a serial
 * actuation can produce (a 30 s resume window plus a lease-TTL fresh window) and still shows a
 * dead LaunchAgent inside the time an ADR 191 ask would otherwise wait on it. Every
 * host-authenticated residency request (poll, progress, turn, report) now stamps the sighting, so a
 * busy host refreshes at report time even mid-actuation.
 */
export const HOST_STALE_MS = 300_000;

/**
 * The host's poll IS its heartbeat (ADR 357). Every `POST /residency/wake-leases` names the host;
 * the daemon received that every 10 s since ADR 131 and never wrote it down, which is why
 * `enrolled_host_stale` could only ever appear on a wake report after the wake had failed. Newest
 * wins; an out-of-order old poll never moves a sighting backwards.
 */
export async function recordHostSeen(
  db: Driver,
  teamId: string,
  host: string,
  now: number,
  /** ADR 463 §2: the member whose host key polled, if any. A team-wide poll never clears it —
   *  a shared label keeps the last sponsor seen there. */
  sponsorId: string | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO host_liveness (team_id, host, seen_at, sponsor_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, host) DO UPDATE SET seen_at = MAX(host_liveness.seen_at, excluded.seen_at),
       sponsor_id = COALESCE(excluded.sponsor_id, host_liveness.sponsor_id)`,
    [teamId, host, now, sponsorId],
  );
}

/** Every host this team has ever heard from, and when — nearest reading of "is the actuator up". */
export async function listHostSeen(db: Driver, teamId: string): Promise<Map<string, number>> {
  const rows = await db.all<{ host: string; seen_at: number }>(
    'SELECT host, seen_at FROM host_liveness WHERE team_id = ?',
    [teamId],
  );
  return new Map(rows.map((r) => [r.host, r.seen_at]));
}

/**
 * The facts `wakeabilityFromFacts` (ADR 189) needs, per enrolled member — the two it was never given
 * (ADR 357): `host_reachable` from the host's last poll, `workspace_readable` from the last wake
 * report. Absent from the map ⇒ not enrolled.
 *
 * `workspace_readable` is false only when the newest `residency.wake_failed` for the seat carries a
 * still-true wakeability (`enrolled_dead_workspace` — the ADR 262 set) AND no `residency.woke` has
 * landed since. The daemon cannot stat a path on the host's filesystem; it can read what the host
 * last reported and whether anything newer contradicts it.
 */
/**
 * ADR 365 §3 — the deciding readers of the wake ledger stay on rows THIS machine minted.
 *
 * The six wake verbs now cross the wire as `ledger` events so `musterd report` can count a team's
 * whole wake economy (ADR 365 §1). But those same rows are the rate policy's state (ADR 131 §4):
 * the hourly cap, the attempt cap, ADR 262's re-spend breaker and ADR 357's `workspace_readable`
 * all COUNT them. Folding a peer's rows into those counts would make wake caps team-wide — a
 * decision crossing the wire, which is residence 3, and not this ADR's to make. So every deciding
 * read carries this predicate and behaves exactly as it did before replication existed.
 *
 * `''` is a row minted here before the stamp existed (every pre-v58 row, and any row whose stamp
 * failed); the subquery is this daemon's node id for the team, absent on a machine that has never
 * enrolled — which is then simply the `''` case. A folded row matches neither.
 *
 * Falsifier: fold a peer's `residency.woke` rows past the hourly cap and poll for a wake here — it
 * must still be ordered. `residency.test.ts` "ignores a peer machine's wake rows" pins it; drop the
 * predicate from `wakesSince` and that case fails.
 */
const MINTED_HERE = `AND origin_node IN ('', COALESCE((SELECT node_id FROM local_node l WHERE l.team_id = audit.team_id), ''))`;

export interface SeatWakeabilityFacts {
  enrolled: true;
  host: string;
  /** Undefined when this daemon has never heard from the host at all — unknown, not stale (ADR
   *  236: absence is not an assertion). A host that HAS polled and stopped is `false`. */
  host_reachable: boolean | undefined;
  workspace_readable: boolean;
  resumable_at: number | null;
}

/**
 * The `wakeabilityFromFacts` inputs for one seat's facts, omitting `host_reachable` when it is
 * unknown — the enum function treats an absent fact as "no evidence to demote on", which is
 * exactly what never-heard-from means (ADR 236).
 */
export function wakeabilityInputs(
  facts: SeatWakeabilityFacts | undefined,
): Pick<WakeabilityFacts, 'host_reachable' | 'workspace_readable'> {
  if (!facts) return {};
  return {
    workspace_readable: facts.workspace_readable,
    ...(facts.host_reachable !== undefined ? { host_reachable: facts.host_reachable } : {}),
  };
}

export async function seatWakeabilityFacts(
  db: Driver,
  teamId: string,
  now: number,
): Promise<Map<string, SeatWakeabilityFacts>> {
  const hosts = await listHostSeen(db, teamId);
  const LAST_FAILURE = `SELECT detail, ts FROM audit
      WHERE team_id = ? AND action = 'residency.wake_failed' AND target = ?
        ${MINTED_HERE}
      ORDER BY ts DESC, id DESC LIMIT 1`;
  const LAST_WOKE = `SELECT ts, detail FROM audit
      WHERE team_id = ? AND action = 'residency.woke' AND target = ?
        ${MINTED_HERE}
      ORDER BY ts DESC, id DESC LIMIT 1`;
  const lastFailure = (name: string) =>
    db.get<{ detail: string; ts: number }>(LAST_FAILURE, [teamId, name]);
  const lastWoke = (name: string) =>
    db.get<{ ts: number; detail: string }>(LAST_WOKE, [teamId, name]);
  const out = new Map<string, SeatWakeabilityFacts>();
  for (const r of await listResidency(db, teamId)) {
    const member = await getMemberById(db, r.member_id);
    const seen = hosts.get(r.host);
    // Never heard from ⇒ unknown, and unknown never demotes: a fresh install, an older host build,
    // or a registry entry nobody has polled for yet all read exactly as they did before this table
    // existed. Only a host that HAS polled and then stopped for HOST_STALE_MS is stale — that is
    // an observed silence, not an assumed one.
    const host_reachable = seen === undefined ? undefined : now - seen < HOST_STALE_MS;
    let workspace_readable = true;
    let resumable_at = r.resumable_at;
    if (member) {
      // ADR 424: the badge input is withdrawn by evidence. A `residency.woke` row newer than the
      // capture whose `session` axis is `fresh` is a wake that did NOT continue the transcript —
      // the ladder skipped it (over the bound, past the horizon) or never looked (ADR 209
      // portable). Measured 2026-09-19: 0 of 42 wakes in five days resumed while every enrolled
      // seat read `resumable`. The enrollment row keeps the true attestation time; only what the
      // roster asserts changes. A resumed wake, or none since the capture, leaves it standing.
      if (resumable_at != null) {
        const woke = await lastWoke(member.name);
        if (woke !== undefined && woke.ts > resumable_at) {
          let session: string | undefined;
          try {
            session = (JSON.parse(woke.detail) as { session?: string }).session;
          } catch {
            /* unreadable detail is not evidence of anything */
          }
          if (session === 'fresh') resumable_at = null;
        }
      }
      const failed = await lastFailure(member.name);
      if (failed) {
        let wakeability: string | undefined;
        try {
          wakeability = (JSON.parse(failed.detail) as { wakeability?: string }).wakeability;
        } catch {
          /* unreadable detail is not evidence of anything */
        }
        if (wakeability === 'enrolled_dead_workspace') {
          const woke = await lastWoke(member.name);
          workspace_readable = woke !== undefined && woke.ts > failed.ts;
        }
      }
    }
    out.set(r.member_id, {
      enrolled: true,
      host: r.host,
      host_reachable,
      workspace_readable,
      resumable_at,
    });
  }
  return out;
}

/**
 * ADR 503 Decision 5: where each seat lives, for the roster's `residence` field. The answer is
 * the seat's node binding (ADR 358 `seat_nodes` → `nodes`) — enrolled for wake or not: a bound
 * seat with no residency row (compo, 2026-10-05) still lives on that machine, and reading it as
 * `nowhere` is what offered `set up` for it on Air 2, the ADR's own falsifier (ADR 509). Never
 * `residency.host`: that
 * column is the hostname string the enrolling actuator declared, and after a seat moves machines
 * it goes stale (2026-10-04: five revive seats bound to Air 2 still read `host = mac.lan`). The
 * earliest unrevoked binding wins — agents are one-node by rule, and a human's first-trusted
 * machine is the one the launcher's `where` should name. An enrolled seat with no unrevoked binding
 *
 * `kind` is `cloud` only for a seat bound to THIS daemon's own node while it runs in cloud mode
 * (ADR 475): a Cloud server is the one place a node row stands for hosted compute rather than a
 * machine someone sits at. A sponsor-hosted seat on a rented box (ADR 463 — the `delta` shape today)
 * enrolled as an ordinary joiner node and reads `node`; marking it `cloud` would need a fact the
 * node row does not carry. A seat with no unrevoked binding is absent from the map; the roster
 * renders that as `null` (nowhere bound).
 */
export async function seatResidences(
  db: Driver,
  teamId: string,
  local: { nodeId: string | null; cloud: boolean },
): Promise<Map<string, Residence>> {
  const rows = await db.all<{ member_id: string; node_id: string; label: string }>(
    `SELECT s.member_id, s.node_id, n.label
       FROM seat_nodes s
       JOIN nodes n ON n.id = s.node_id
      WHERE s.team_id = ? AND n.revoked_at IS NULL
      ORDER BY s.member_id, s.bound_at, s.node_id`,
    [teamId],
  );
  const out = new Map<string, Residence>();
  for (const r of rows) {
    if (out.has(r.member_id)) continue;
    out.set(r.member_id, {
      node: r.node_id,
      node_label: r.label,
      kind: local.cloud && local.nodeId !== null && r.node_id === local.nodeId ? 'cloud' : 'node',
    });
  }
  return out;
}

/** Member ids enrolled in residency — the roster's `wakeable` flag (`offline · wakeable`). */
export async function listWakeableMemberIds(db: Driver, teamId: string): Promise<Set<string>> {
  const rows = await db.all<{ member_id: string }>(
    'SELECT member_id FROM residency WHERE team_id = ?',
    [teamId],
  );
  return new Set(rows.map((r) => r.member_id));
}

/** A seat's live (unexpired, unreported) lease, if any — the mutual-exclusion read. */
async function liveLease(db: Driver, memberId: string, now: number): Promise<WakeLeaseRow | null> {
  return (
    (await db.get<WakeLeaseRow>(
      "SELECT * FROM wake_leases WHERE member_id = ? AND status = 'leased' AND expires_at > ? LIMIT 1",
      [memberId, now],
    )) ?? null
  );
}

/** Completed wake actuations (reported or expired-as-failed) for a seat since `sinceTs` — the
 *  derived rate-policy read (ADR 131 §4: `residency.woke`/`wake_failed` rows ARE the rate state). */
async function wakesSince(
  db: Driver,
  teamId: string,
  seatName: string,
  sinceTs: number,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
          AND target = ? AND ts > ? ${MINTED_HERE}`,
    [teamId, seatName, sinceTs],
  );
  return row?.n ?? 0;
}

/** When does this seat's deferral snooze lift? `null` when there is no deferral to honour. Derived
 *  from `residency.wake_deferred` audit rows (increment 4's guard) — deliberately NOT part of
 *  `wakesSince`/`attemptsForAct`: a deferral burns no rate or attempt budget, it only snoozes.
 *
 *  ADR 485: a local-session deferral backs off. The streak is the run of newest deferrals with the
 *  same local-session reason, broken by a different reason, by a woke/failed wake after it, or by a
 *  gap longer than the cap plus the base (the session closed and a later one opened). The window is
 *  base × 2^(streak − 1), capped. Every other reason keeps the flat base window. */
async function deferralSnoozeUntil(
  db: Driver,
  teamId: string,
  seatName: string,
): Promise<number | null> {
  const rows = await db.all<{ ts: number; reason: string }>(
    `SELECT ts, COALESCE(json_extract(detail, '$.reason'), '') AS reason FROM audit
        WHERE team_id = ? AND action = 'residency.wake_deferred'
          AND target = ? ${MINTED_HERE}
          AND COALESCE(json_extract(detail, '$.reason'), '') <> ?
        ORDER BY ts DESC LIMIT ?`,
    [teamId, seatName, WAKE_DEFER_ACTUATOR_RESTART, DEFER_STREAK_SCAN],
  );
  const newest = rows[0];
  if (!newest) return null;
  if (!LOCAL_SESSION_DEFER_REASONS.includes(newest.reason)) return newest.ts + WAKE_DEFER_SNOOZE_MS;
  const lastWake =
    (
      await db.get<{ ts: number | null }>(
        `SELECT MAX(ts) AS ts FROM audit
          WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
            AND target = ? ${MINTED_HERE}`,
        [teamId, seatName],
      )
    )?.ts ?? 0;
  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.reason !== newest.reason) break;
    if (row.ts < lastWake) break;
    if (rows[i - 1]!.ts - row.ts > WAKE_DEFER_SNOOZE_CAP_MS + WAKE_DEFER_SNOOZE_MS) break;
    streak++;
  }
  const window = Math.min(WAKE_DEFER_SNOOZE_MS * 2 ** (streak - 1), WAKE_DEFER_SNOOZE_CAP_MS);
  return newest.ts + window;
}

/** Actuation attempts recorded for one act (woke + failed) — drives the per-act attempt cap. */
async function attemptsForAct(db: Driver, teamId: string, actId: string): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action IN ('residency.woke','residency.wake_failed')
          AND json_extract(detail, '$.act') = ? ${MINTED_HERE}`,
    [teamId, actId],
  );
  return row?.n ?? 0;
}

/** Has this act already been declared exhausted? (One terminal row per act, ever.) */
async function isExhausted(db: Driver, teamId: string, actId: string): Promise<boolean> {
  const row = await db.get<{ one: number }>(
    `SELECT 1 AS one FROM audit
        WHERE team_id = ? AND action = 'residency.wake_exhausted'
          AND json_extract(detail, '$.act') = ? ${MINTED_HERE} LIMIT 1`,
    [teamId, actId],
  );
  return row != null;
}

/**
 * When this act last completed a wake of this seat — the newest `residency.woke` row naming it —
 * or null if it never has (ADR 434 §b). A `wake_failed` is deliberately not counted: a spawn that
 * never ran did not spend the act, and the attempt cap still governs those.
 */
async function lastWokeForAct(
  db: Driver,
  teamId: string,
  seatName: string,
  actId: string,
): Promise<number | null> {
  const row = await db.get<{ ts: number }>(
    `SELECT MAX(ts) AS ts FROM audit
        WHERE team_id = ? AND action = 'residency.woke' AND target = ?
          AND json_extract(detail, '$.act') = ? ${MINTED_HERE}`,
    [teamId, seatName, actId],
  );
  return row?.ts ?? null;
}

/**
 * Has anyone OTHER than the seat added to the act's thread — or named it by `in_reply_to` — since
 * `sinceTs`? That is what makes a spent act live again (ADR 434 §b): the sender nudging, a peer
 * adding to the exchange. The seat's own later turn is not a reason to wake the seat.
 */
async function threadReopenedSince(
  db: Driver,
  teamId: string,
  memberId: string,
  actId: string,
  sinceTs: number,
): Promise<boolean> {
  const row = await db.get<{ one: number }>(
    `SELECT 1 AS one FROM messages x
         JOIN messages a ON a.id = ?
        WHERE x.team_id = ? AND x.from_member != ? AND x.created_at > ?
          AND (x.thread_id = COALESCE(a.thread_id, a.id)
               OR x.in_reply_to = a.id)
        LIMIT 1`,
    [actId, teamId, memberId, sinceTs],
  );
  return row != null;
}

/**
 * The seat's wake horizon (ADR 434 §c): the newest FRESH enrollment — a `residency.enrolled` audit
 * row with no `previous_host`, i.e. a first enrollment or one after a revoke. An act received
 * before it never wakes the seat. A re-enrollment (policy tweak, host swap) carries `previous_host`
 * and does not move it, so tuning a live seat cannot silently retire what it was already owed.
 *
 * Why it exists: enrolling gptbot on 2026-09-21 12:47, dormant since a 2026-09-05 revoke, put its
 * July–September obligations on the batched lane oldest-first and the daemon drained them one paid
 * wake per window, ahead of anything current. An enrollment says "from now"; the enroll response
 * reports what it left behind so the operator can re-send what still matters.
 */
export async function wakeHorizon(
  db: Driver,
  teamId: string,
  seatName: string,
): Promise<number | null> {
  const row = await db.get<{ ts: number }>(
    `SELECT MAX(ts) AS ts FROM audit
        WHERE team_id = ? AND action = 'residency.enrolled' AND target = ?
          AND json_extract(detail, '$.previous_host') IS NULL`,
    [teamId, seatName],
  );
  return row?.ts ?? null;
}

/** Receipt time of one act, for the horizon test; null for an unknown id. */
async function actReceivedAt(db: Driver, teamId: string, actId: string): Promise<number | null> {
  const row = await db.get<{ created_at: number }>(
    'SELECT created_at FROM messages WHERE team_id = ? AND id = ?',
    [teamId, actId],
  );
  return row?.created_at ?? null;
}

/**
 * The daemon-composed spawn line (ADR 088 §4 injection bar): structured fields only — act enum,
 * delimited sender/seat names, the act's id, one instruction to read the inbox through the
 * governed tools. The triggering act's **body never appears here** (nor anywhere in a lease
 * response, ADR 128).
 *
 * **The line hands over the act id verbatim** (lane 01M2P698NJ). `team_wake_context` authorizes
 * the act path by RECIPIENT and takes the id as its argument; a line that only said "a message is
 * waiting" left the woken model to invent one. Measured 2026-09-16 on a native wake of seat compo:
 * the loop's first call was `team_wake_context {act_id: "latest"}` → `forbidden wake context
 * target` (audit `residency.context_read target=latest reason=forbidden`), so the packet the primer
 * says to read first was unreadable on the very wake that composed this line. The review line got
 * the same treatment on 2026-09-04 (`composeWorkOrderLine`); an id is a structured field, not
 * body text, so the injection bar is unchanged.
 */
function composeWakeLine(
  seat: string,
  teamSlug: string,
  act: string,
  sender: string,
  actId?: string,
): string {
  // ADR 430 §7: the packet IS the orientation. Still ids only — sender, act, act id — no body
  // text (ADR 088 §4).
  const read =
    actId !== undefined
      ? `Read \`team_wake_context {act_id: "${actId}"}\``
      : 'Read `team_wake_context`';
  // ADR 436 clause 5 — discharge, in words, on every harness. ADR 434's predicate counts only an
  // act IN the thread (accept/decline, a resolve on it, or the recipient's own reply there); a
  // directed message sent beside it discharges nothing, and the sender keeps waiting. Ghost's
  // arm-E answer (2026-09-21) was exactly that shape — no line had ever said otherwise.
  const answer =
    actId !== undefined
      ? `answer IN its thread (\`reply_to: "${actId}"\`)`
      : 'answer IN its thread';
  return (
    `${wakePrefix(teamSlug)} you are seat "${seat}": a ${act} from "${sender}" is waiting ` +
    `(${POINTER}). ${read} — it carries the thread, what else is open, and your memory. ` +
    `Fetch more only for what it lists under \`fetch\`. Then ${answer} — accept, decline, ` +
    `resolve, or a reply; a message outside the thread answers nothing.`
  );
}

/**
 * ADR 442 (the wall, spec §4) — every line names its team up front, in the one shape the interrupt
 * line uses too (`musterd [<team>]:`), so a multi-team machine is unambiguous to the receiver's check.
 */
function wakePrefix(teamSlug: string): string {
  return `musterd [${teamSlug}]: wake —`;
}

/** The receiver acts only on its own authenticated read of the id, never on the line's words. */
const POINTER = 'pointer only — read it as yourself';

/**
 * Work-order line (ADR 179 / 191 / 199): ids only — never a title, never free text.
 *
 * **The review line names the ACT, not just the lane.** `team_wake_context` has two paths and they
 * are not interchangeable: `lane_id` authorizes the lane's OWNER and answers `work_order` /
 * `continue_lane`, while `act_id` authorizes the act's RECIPIENT and answers `review` with the lane
 * block already attached. A reviewer never owns the lane it reviews, so a line naming only the lane
 * sent them at the one path that must refuse them — measured 2026-09-04: 38 of 47 review-edge wakes
 * had a `residency.context_read` deny within ±5 minutes of the wake, 83 of 87 lane-target denials
 * being a seat asking about a lane it does not own. Every one of those 47 wakes carried an act, and
 * every one of those acts carried `meta.lane_review`, so the act path serves all of them. Widening
 * the lane path instead would have handed reviewers a packet that calls their job `continue_lane`.
 */
function composeWorkOrderLine(
  seat: string,
  teamSlug: string,
  laneId: string,
  kind: 'review' | 'dispatch',
  actId?: string,
): string {
  if (kind === 'review') {
    // `act_id` is present on every review work order the picker builds; the lane-only phrasing is
    // kept as the honest fallback rather than inventing an id we were not given (ADR 236).
    return actId !== undefined
      ? `${wakePrefix(teamSlug)} you are seat "${seat}": lane ${laneId} needs your review ` +
          `(${POINTER}). Orient via team_wake_context {act_id: "${actId}"} (then team_next) and begin.`
      : `${wakePrefix(teamSlug)} you are seat "${seat}": lane ${laneId} needs your review ` +
          `(${POINTER}). Orient via team_next and begin.`;
  }
  // The owner is authorized on the lane path; spell its argument the same way the act path is.
  return (
    `${wakePrefix(teamSlug)} you are seat "${seat}": lane ${laneId} is yours (${POINTER}) — ` +
    `orient via team_wake_context {lane_id: "${laneId}"} (then team_next) and begin.`
  );
}

function loopEdgeOf(candidate: WakeCandidate): LoopEdge | null {
  if (candidate.derivation !== 'work_order') return null;
  if (candidate.work_order_kind === 'review') return 'review';
  if (candidate.work_order_kind === 'dispatch') {
    return candidate.act_id ? 'dispatch_handoff' : 'dispatch_continuation';
  }
  return null;
}

async function workOrderEdgeFailureCount(
  db: Driver,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'residency.wake_failed'
          AND json_extract(detail, '$.lane_id') = ?
          AND json_extract(detail, '$.edge') = ? ${MINTED_HERE}`,
    [teamId, laneId, edge],
  );
  return row?.n ?? 0;
}

/** ADR 306: successful wakes already spent on this (lane, edge) — the succeeding-chain bound. */
async function workOrderEdgeWokeCount(
  db: Driver,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'residency.woke'
          AND json_extract(detail, '$.lane_id') = ?
          AND json_extract(detail, '$.edge') = ? ${MINTED_HERE}`,
    [teamId, laneId, edge],
  );
  return row?.n ?? 0;
}

/**
 * ADR 306: has the lane moved since the last successful wake on this edge? A continuation wake that
 * changed nothing does not buy the next one (ADR 247 — progress is not an outcome; ADR 250 §2 — no
 * heartbeat that burns spend while nothing changed). No prior woke ⇒ nothing to have stalled since,
 * so the first firing is always permitted.
 */
async function laneMovedSinceLastWoke(
  db: Driver,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
): Promise<boolean> {
  const last = await db.get<{ ts: number }>(
    `SELECT ts FROM audit
        WHERE team_id = ? AND action = 'residency.woke'
          AND json_extract(detail, '$.lane_id') = ? ${MINTED_HERE}
          AND json_extract(detail, '$.edge') = ?
        ORDER BY ts DESC, id DESC LIMIT 1`,
    [teamId, laneId, edge],
  );
  if (!last) return true;
  const lane = await db.get<{ updated_at: number }>(
    'SELECT updated_at FROM lanes WHERE team_id = ? AND id = ?',
    [teamId, laneId],
  );
  if (!lane) return false;
  return lane.updated_at > last.ts;
}

async function workOrderEdgeStillTrue(
  db: Driver,
  teamId: string,
  laneId: string,
  edge: LoopEdge,
): Promise<boolean> {
  const row = await db.get<{ detail: string }>(
    `SELECT detail FROM audit
        WHERE team_id = ? AND action = 'residency.wake_failed'
          AND json_extract(detail, '$.lane_id') = ? ${MINTED_HERE}
          AND json_extract(detail, '$.edge') = ?
        ORDER BY ts DESC, id DESC LIMIT 1`,
    [teamId, laneId, edge],
  );
  if (!row) return false;
  let parsed: { wakeability?: string };
  try {
    parsed = JSON.parse(row.detail) as { wakeability?: string };
  } catch {
    return false;
  }
  return parsed.wakeability !== undefined && STILL_TRUE_WAKEABILITIES.includes(parsed.wakeability);
}

/** A due-wake candidate before leasing. Act fields optional on board continuation (ADR 199). */
interface WakeCandidate {
  act_id?: string;
  act?: string;
  sender?: string;
  lane: WakeLane;
  derivation: WakeDerivation;
  lane_id?: string;
  work_order_kind?: 'review' | 'dispatch';
  /** ADR 210: set only when the triggering act is a reply INTO an existing thread. The thread id
   *  itself never leaves the daemon on the order — it is read here purely to judge eligibility. */
  thread_id?: string;
  /** ADR 210: when the triggering act was sent, for the eligibility recency test. */
  act_ts?: number;
}

/** ADR 209 rollout: typed handoff/review/work-order wakes are portable now. Ordinary inbox
 * deliveries enter the fresh cohort only when the team has explicitly enabled it. */
function isPortableWakeCandidate(candidate: WakeCandidate, portableInboxReplies: boolean): boolean {
  return (
    candidate.derivation === 'work_order' || candidate.act === 'handoff' || portableInboxReplies
  );
}

/**
 * ADR 210: may this wake even be *considered* for a local resume?
 *
 * This is the daemon's whole contribution, and it is deliberately tiny. The daemon knows the thread
 * but never the session — so it cannot decide to resume, only decline to rule it out. Everything
 * that could prove causality (session id, transcript path, harness class) lives on the host and
 * stays there.
 *
 * Eligible means all of: the master switch is on, the wake is an ordinary directed reply (not a
 * work-order, review, or handoff — those are portable by ADR 209 and stay that way), the triggering
 * act sits INSIDE an existing thread, and it is recent enough that a live session plausibly still
 * holds that dialogue. Sender text is never consulted.
 */
function isResumeEligible(
  candidate: WakeCandidate,
  policy: { exact_match_resume: boolean; resume_eligible_ms: number },
  now: number,
): boolean {
  if (!policy.exact_match_resume) return false;
  if (candidate.derivation === 'work_order') return false;
  if (candidate.act === 'handoff') return false;
  if (candidate.thread_id === undefined) return false;
  if (candidate.act_ts === undefined) return false;
  return now - candidate.act_ts <= policy.resume_eligible_ms;
}

/**
 * Unanswered lane-acceptance asks addressed to this seat whose lane is still awaiting acceptance
 * (ADR 191 work_order derivation / ADR 192 vocab). Oldest first. Deliberately NOT folded into
 * `openDirectedLedger` — arbitrary asks stay non-wakeable; only this board edge spends.
 */
async function dueReviewWorkOrders(
  db: Driver,
  teamId: string,
  teamSlug: string,
  member: MemberRow,
): Promise<WakeCandidate[]> {
  const rows = await db.all<MessageRow>(
    `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND m.act = 'ask'
          AND m.to_kind = 'member'
          AND m.to_member = ?
          AND json_extract(m.meta, '$.lane_review.lane') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.act IN ('accept','decline')
               AND r.in_reply_to = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        ORDER BY m.created_at ASC`,
    [teamId, member.id],
  );
  const out: WakeCandidate[] = [];
  for (const row of rows) {
    let laneId: string | undefined;
    try {
      laneId = (JSON.parse(row.meta ?? '{}') as { lane_review?: { lane?: string } }).lane_review
        ?.lane;
    } catch {
      continue;
    }
    if (!laneId) continue;
    const lane = await getLane(db, teamId, laneId, teamSlug);
    if (!lane || !isAwaitingAcceptance(lane.state)) continue;
    const sender = await getMemberById(db, row.from_member);
    out.push({
      act_id: row.id,
      act: row.act,
      sender: sender?.name ?? '?',
      lane: 'batched',
      derivation: 'work_order',
      lane_id: laneId,
      work_order_kind: 'review',
    });
  }
  return out;
}

/**
 * Unanswered lane handoffs to this seat (ADR 199 dispatch handoff edge). Oldest first. Not folded
 * into inbox candidates — when the dispatch loop is on they become work_orders; when off they
 * still wake as reply doorbells via `dueCandidates` / `openDirectedLedger`.
 */
async function dueDispatchHandoffWorkOrders(
  db: Driver,
  teamId: string,
  teamSlug: string,
  member: MemberRow,
): Promise<WakeCandidate[]> {
  const rows = await db.all<MessageRow>(
    `SELECT m.* FROM messages m
        WHERE m.team_id = ?
          AND m.act = 'handoff'
          AND m.to_kind = 'member'
          AND m.to_member = ?
          AND json_extract(m.meta, '$.lane_handoff.lane') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id AND r.act IN ('accept','decline')
               AND r.in_reply_to = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM messages v
             WHERE v.team_id = m.team_id AND v.act = 'resolve'
               AND v.thread_id = COALESCE(m.thread_id, m.id))
        ORDER BY m.created_at ASC`,
    [teamId, member.id],
  );
  const out: WakeCandidate[] = [];
  for (const row of rows) {
    let laneId: string | undefined;
    try {
      laneId = (JSON.parse(row.meta ?? '{}') as { lane_handoff?: { lane?: string } }).lane_handoff
        ?.lane;
    } catch {
      continue;
    }
    if (!laneId) continue;
    const lane = await getLane(db, teamId, laneId, teamSlug);
    if (!lane || lane.owner_seat !== member.name) continue;
    if (isAwaitingAcceptance(lane.state) || LANE_TERMINAL_STATES.has(lane.state)) continue;
    const sender = await getMemberById(db, row.from_member);
    out.push({
      act_id: row.id,
      act: row.act,
      sender: sender?.name ?? '?',
      lane: 'batched',
      derivation: 'work_order',
      lane_id: laneId,
      work_order_kind: 'dispatch',
    });
  }
  return out;
}

/**
 * Board-owned claimed/active lanes with no triggering act (ADR 199 continuation edge).
 * Never wakes for unowned open work.
 */
async function dueDispatchContinuationWorkOrders(
  db: Driver,
  teamId: string,
  teamSlug: string,
  member: MemberRow,
): Promise<WakeCandidate[]> {
  const out: WakeCandidate[] = [];
  for (const lane of await listLanes(db, teamId, teamSlug, { owner: member.name })) {
    if (lane.state !== 'claimed' && lane.state !== 'active') continue;
    if (isAwaitingAcceptance(lane.state) || LANE_TERMINAL_STATES.has(lane.state)) continue;
    out.push({
      lane: 'batched',
      derivation: 'work_order',
      lane_id: lane.id,
      work_order_kind: 'dispatch',
    });
  }
  return out;
}

/** Was this act sent from a provenance-`wake` occupancy? Server-stamped at insert (v21) — the
 *  ping-pong demotion read (ADR 131 §4). Null (pre-v21 rows, no live presence at send) ⇒ not wake. */
/** Of these act ids, the ones sent from a dream session (ADR 494 §4). One query, none when empty. */
async function dreamSentIds(
  db: Driver,
  ids: ReadonlyArray<string | undefined>,
): Promise<Set<string>> {
  const wanted = ids.filter((id): id is string => id !== undefined);
  if (wanted.length === 0) return new Set();
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM messages WHERE from_provenance = 'dream' AND id IN (${wanted.map(() => '?').join(', ')})`,
    wanted,
  );
  return new Set(rows.map((r) => r.id));
}

async function sentFromWake(db: Driver, actId: string): Promise<boolean> {
  const row = await db.get<{ from_provenance: string | null }>(
    'SELECT from_provenance FROM messages WHERE id = ?',
    [actId],
  );
  return row?.from_provenance === 'wake';
}

/**
 * Derive this member's due-wake candidates, immediate lane first (ADR 131 §3):
 *
 * - **immediate** — the ADR 088 interrupt predicate (`pendingInterrupts`: urgent or steer, directed,
 *   unresolved) over the seat's unread inbox — the same scarcity and `can_flag_urgent` gate as the
 *   live interrupt line; residency adds a new *state* it reaches, not a new way to command a machine.
 * - **batched** — the ADR 090 open directed ledger (request_help/handoff + urgent directed acts,
 *   unanswered), oldest first, subject to the cooldown checked by the caller.
 *
 * **Ping-pong demotion** (ADR 131 §4, landed increment 5): an interrupt-class act *sent from a
 * provenance-`wake` occupancy* never wakes another seat immediately — it is demoted to the batched
 * lane (kept as a candidate there, ahead of the ledger's, since it is still interrupt-class), so
 * machine-to-machine chains run at cooldown cadence under the caps, without lineage tracking.
 */
async function dueCandidates(
  db: Driver,
  teamSlug: string,
  member: MemberRow,
  lanes: {
    immediate: boolean;
    batched: boolean;
    raisedDeferralWakes: boolean;
    /** ADR 378 inc 4: does a huddle OPEN that names this seat summon it? Effective seat policy. */
    conveneHuddles: boolean;
    /** ADR 271 §4, built: the team's `incident.wake_on_route` — the "now yours" notice wakes. */
    wakeOnIncidentRoute: boolean;
    /** ADR 271 §4, built: the team's `incident.wake_on_resolve` — the "resolved" notice wakes. */
    wakeOnIncidentResolve: boolean;
  },
  /**
   * The team's open directed ledger, computed ONCE for the whole poll — as a THUNK, so a team where
   * no seat reaches the batched lane pays nothing at all.
   *
   * It used to be read here, which meant `openDirectedLedger(db, member.team_id)` — a TEAM-scoped
   * query whose answer is identical for every seat in the poll — ran once per enrolled seat. It is
   * three correlated `NOT EXISTS` subqueries over the whole `messages` table on unindexed
   * `json_extract`, unbounded, and then `actDeliveryOf` per returned row, which queries again per
   * row and per recipient. Measured 2026-09-04 by big-body on the wedged daemon: a 3-second stack
   * sample spent 2,406 of 2,407 samples inside synchronous `sqlite3_step` while `/health` timed out
   * and the process stayed alive.
   *
   * Passed in rather than memoised behind a module-level cache on purpose: the lifetime that is
   * correct here is exactly one poll transaction, and a parameter cannot outlive it or go stale.
   */
  ledger: () => Promise<ActDelivery[]>,
): Promise<WakeCandidate[]> {
  const immediate: WakeCandidate[] = [];
  const batched: WakeCandidate[] = [];
  const seen = new Set<string>();

  // A team has tens of members and a window has thousands of rows, so the per-row `getMemberById`
  // asked the same few questions over and over — 800 statements to learn 31 names. Memoised for the
  // life of this derivation only: membership cannot change inside the poll's transaction, and the
  // map dies with the call, so there is no cache to invalidate. It holds the lookup, not its result:
  // the rows hydrate concurrently, and a map of settled names missed on every one of them.
  const names = new Map<string, Promise<string | undefined>>();
  const nameOf = (id: string): Promise<string | undefined> => {
    let name = names.get(id);
    if (!name) names.set(id, (name = getMemberById(db, id).then((m) => m?.name)));
    return name;
  };

  if (lanes.immediate || lanes.batched) {
    const cursor = await getCursor(db, member.id);
    // Only the shapes `pendingInterrupts` can use — the seat's unread depth is not this poll's
    // business, and it is the last term that still grew with it.
    const rows = await listInterruptCandidates(db, member, { cursorTs: cursor.last_read_ts });
    const envelopes = await Promise.all(
      rows.map(async (r) =>
        rowToEnvelope(
          r,
          teamSlug,
          (await nameOf(r.from_member)) ?? '?',
          r.to_member ? ((await nameOf(r.to_member)) ?? null) : null,
        ),
      ),
    );
    // The ONLY opt-in this rail makes to the shared predicate. `obligations` and `huddles` stay off
    // here on purpose (ADR 225, ADR 378): both admit acts by the handful and would route paid wakes
    // around their own policy gates. `huddleOpens` admits exactly one act per huddle and is gated by
    // the seat's own effective policy, which is what makes it affordable on this side.
    for (const env of pendingInterrupts(envelopes, member.name, {
      huddleOpens: lanes.conveneHuddles,
      incidentRoutes: lanes.wakeOnIncidentRoute,
      incidentResolves: lanes.wakeOnIncidentResolve,
    })) {
      if (seen.has(env.id)) continue;
      seen.add(env.id);
      // ADR 271 §4: a route is one wake for one named beneficiary — immediate. A resolve tells the
      // seats parked behind the red they may move; that is batched work, not an interruption.
      const demoted =
        (await sentFromWake(db, env.id)) ||
        (env.act === 'message' &&
          typeof (env.meta as { incident?: { resolved_by?: unknown } } | null)?.incident
            ?.resolved_by === 'string');
      const candidate: WakeCandidate = {
        act_id: env.id,
        act: env.act,
        sender: env.from,
        lane: demoted ? 'batched' : 'immediate',
        derivation: demoted ? 'batched' : 'immediate',
        // ADR 210: an explicit thread means this act is a reply INTO a dialogue. An act that opens
        // its own thread has no prior exchange to resume into, so it is never eligible.
        ...(env.thread ? { thread_id: env.thread } : {}),
        act_ts: env.ts,
      };
      if (demoted) {
        if (lanes.batched) batched.push(candidate);
      } else if (lanes.immediate) {
        immediate.push(candidate);
      }
    }
  }

  if (lanes.batched) {
    for (const delivery of await ledger()) {
      if (seen.has(delivery.id)) continue;
      const mine = delivery.recipients.find((r) => r.seat === member.name);
      if (!mine || mine.state === 'answered') continue;
      seen.add(delivery.id);
      batched.push({
        act_id: delivery.id,
        act: delivery.act,
        sender: delivery.from,
        lane: 'batched',
        derivation: 'batched',
      });
    }
  }

  // ADR 211 §4: an act its recipient deferred is not a wake reason — they said "not now", and
  // spawning them for it anyway would make the primitive a lie. Suppressed here for BOTH candidate
  // sources above, since either can surface the same act.
  //
  // The fold reads the party-scoped team timeline, not the inbox: `listInbox` excludes the member's
  // own sends and a deferring `wait` IS the member's own send.
  // ADR 494 §4 "no chain": an act a dream sent is never a wake reason, on either lane — one
  // seat's dream cannot wake a second seat, so a night has no chains to bound.
  const fromDream = await dreamSentIds(
    db,
    [...immediate, ...batched].map((c) => c.act_id),
  );
  const due = [...immediate, ...batched].filter((c) => !fromDream.has(c.act_id ?? ''));
  // Nothing is due, so there is nothing to suppress — and the only use of the scan below is
  // `due.flatMap`, which returns [] over an empty array whatever the deferrals say. Before this the
  // 2,000-row window was marshalled per seat per poll to filter a list that was already empty: the
  // common case at idle, and pure cost. An earlier fix narrowed the HYDRATION of this window (see
  // the note below) but left the query itself running unconditionally.
  if (due.length === 0) return due;
  const window = await listTeamMessages(db, member.team_id, {
    forMemberId: member.id,
    limit: DEFERRAL_SCAN_LIMIT,
  });
  // Hydration costs two member lookups a row, so it is spent per row only where a name is actually
  // read. This poll runs in one transaction on the request path every 30s per enrolled seat: a cost
  // that scales with the window rather than with what is due starves the event loop for every other
  // request as the log grows (measured: 840ms and 8000+ lookups at idle, `/health` timing out behind
  // it). Same window, same limit, same order — only the hydration is narrowed.
  const hydrate = (rows: MessageRow[]): Promise<Envelope[]> =>
    Promise.all(
      rows.map(async (r) =>
        rowToEnvelope(
          r,
          teamSlug,
          (await nameOf(r.from_member)) ?? '?',
          r.to_member ? ((await nameOf(r.to_member)) ?? null) : null,
        ),
      ),
    );
  // `deferrals` reads exactly one shape — the seat's OWN `wait` acts — so the rest of the window is
  // hydrated for nothing on the overwhelmingly common path where the seat has deferred nothing.
  const held = deferrals(
    await hydrate(window.filter((r) => r.act === 'wait' && r.from_member === member.id)),
    member.name,
  );
  if (held.size === 0) return due;
  // A deferral IS held: `raisedDeferrals` reads the whole window (it needs every act on the deferred
  // subjects, and their threads), so the full hydration is paid here — where it is load-bearing.
  const scan = await hydrate(window);

  // ADR 214 (ADR 211 inc 2): once a deferral's condition fires the act is pending again, and
  // `raised_deferral_wakes`
  // decides whether that also makes it wake-eligible. Off (launch default) keeps every deferred target
  // suppressed, raised or not — the ADR 211 increment-1 behaviour, where a raised act simply waits in
  // the inbox for the seat to return on its own.
  //
  // A raised act is forced onto the **batched** lane regardless of how it was derived: the Member chose
  // to put it down, so its return must not jump the interrupt line their deferral took it out of. That
  // also means a seat pinned to the interrupt lane never receives one — batched is closed for it.
  const raised =
    lanes.raisedDeferralWakes && lanes.batched
      ? raisedDeferrals(scan, member.name)
      : new Set<string>();
  return due.flatMap((c) => {
    if (!c.act_id || !held.has(c.act_id)) return [c];
    if (!raised.has(c.act_id)) return [];
    return [{ ...c, lane: 'batched' as const, derivation: 'batched' as const }];
  });
}

/**
 * The host's poll (`POST …/residency/wake-leases`), run **in one transaction**: derive due wakes for
 * the seats enrolled to `host`, insert a lease per order, and return the orders — two hosts, a crash
 * mid-spawn, or a re-poll race can never double-spawn a seat (ADR 131 §4). Per seat, in order:
 *
 * 1. enrolled to this host (a seat enrolled elsewhere derives nothing here — last-enrolled-wins);
 * 2. **offline** — no live presence AND not held within reclaim grace (a reservation may be
 *    reconnecting on its own; waking it would race the reclaim);
 * 3. no live lease (mutual exclusion — the stored bit);
 * 3b. not snoozed by a recent `residency.wake_deferred` (increment 4's local-session guard —
 *     derived, burns no budget);
 * 4. under the hourly cap (derived); the batched lane additionally respects the cooldown (derived);
 * 5. per act: not exhausted; an act at the attempt cap writes the terminal
 *    `residency.wake_exhausted` (once) and is skipped — termination is provable:
 *    wake → cooldown → cap → exhausted.
 *
 * Every rate gate reads the seat's **effective policy** (team defaults ⊕ enrollment override,
 * increment 5) — and the emitted order carries the actuation knobs (tool policy, bounds, hygiene
 * bound) so the host applies them without ever reading policy itself.
 *
 * One lease per seat per poll (the composed line names one act; the woken session reads its whole
 * inbox anyway). Audit `residency.wake_leased` is written here per lease — actor null (a machine
 * decision), best-effort by `appendAudit`'s contract.
 */
/**
 * ADR 463 §1: whose seats one host credential may serve. `creatorId` is the member who minted it
 * (null for the legacy team key or an unrecorded mint); `teamWide` is true for admin-minted and
 * legacy keys.
 */
export interface HostScope {
  creatorId: string | null;
  teamWide: boolean;
}

/** The legacy team key and pre-ADR-463 callers: every unsponsored seat, no sponsored one. */
export const TEAM_WIDE_HOST: HostScope = { creatorId: null, teamWide: true };

/**
 * ADR 463 §1 (big-body's REQUIRED on #1779): a SPONSORED seat is served only by a host key its
 * sponsor minted — never by a team-wide key, even one sharing its host label, because a label is
 * not a machine and "runs on the sponsor's own machine" is the guarantee. An unsponsored seat is
 * served only by a team-wide key, as before.
 */
export function hostMayServe(scope: HostScope, member: MemberRow): boolean {
  if (member.sponsored_by !== null) return scope.creatorId === member.sponsored_by;
  return scope.teamWide;
}

/**
 * ADR 463 §2: the one `provisioned` wake — a `ready` provision whose seat has not yet been woken
 * for it. Marks it taken in the same call, so a second poll never derives it again. Runs inside
 * the wake-lease transaction. No act backs it (no fake directed act is written).
 */
export async function takeProvisionedWake(
  db: Driver,
  teamId: string,
  memberId: string,
  now = Date.now(),
): Promise<{ id: string; sponsor_id: string } | undefined> {
  const row = await db.get<{ id: string; sponsor_id: string }>(
    `SELECT id, sponsor_id FROM host_provisions WHERE team_id = ? AND member_id = ?
         AND state = 'ready' AND first_wake_at IS NULL ORDER BY ready_at ASC LIMIT 1`,
    [teamId, memberId],
  );
  if (!row) return undefined;
  await db.run('UPDATE host_provisions SET first_wake_at = ? WHERE id = ?', [now, row.id]);
  return row;
}

/** The provisioned wake's line: who created the seat, and the one thing to do first. */
function composeProvisionedLine(seat: string, teamSlug: string, sponsor: string): string {
  return (
    `${wakePrefix(teamSlug)} you are seat "${seat}": you were just created by "${sponsor}"; ` +
    'greet them with team_send and ask what to build.'
  );
}

/**
 * The dream wake's line (ADR 494 §1): it answers no act and works no lane, so it names neither —
 * only that this is a dream, where the packet is, and the skill that says what a dream may write.
 * The packet carries the skill itself (lane 01M44B3C5Q): the path is only the fallback, because a
 * seat's workspace can rest on a branch that predates it.
 */
function composeDreamLine(seat: string, teamSlug: string): string {
  return (
    `${wakePrefix(teamSlug)} you are seat "${seat}", woken to dream: read your packet with ` +
    '`musterd dream`, follow the dreaming skill its `skill` field carries (else ' +
    '.agents/skills/dreaming/SKILL.md), write only ' +
    'insights, wiki pages and your seat note, then stop.'
  );
}

/**
 * Tonight's dream spend for one seat (ADR 494 §3): dream leases taken since the night began, less
 * the ones the host deferred (a working human never spends a budget), and their reported cost.
 */
async function dreamNight(
  db: Driver,
  teamId: string,
  seatName: string,
  nightStart: number,
): Promise<{ count: number; costUsd: number }> {
  const leased = await db.all<{ lease_id: string | null }>(
    `SELECT json_extract(detail, '$.lease_id') AS lease_id FROM audit
        WHERE team_id = ? AND action = 'residency.wake_leased' AND target = ? AND ts >= ?
          AND json_extract(detail, '$.derivation') = 'dream' ${MINTED_HERE}`,
    [teamId, seatName, nightStart],
  );
  if (leased.length === 0) return { count: 0, costUsd: 0 };
  const deferred = new Set(
    (
      await db.all<{ lease_id: string | null }>(
        `SELECT json_extract(detail, '$.lease_id') AS lease_id FROM audit
            WHERE team_id = ? AND action = 'residency.wake_deferred' AND target = ? AND ts >= ?`,
        [teamId, seatName, nightStart],
      )
    ).map((r) => r.lease_id),
  );
  const spent = new Set(leased.map((r) => r.lease_id).filter((id) => !deferred.has(id)));
  const costs = await db.all<{ lease_id: string | null; cost: number | null }>(
    `SELECT json_extract(detail, '$.lease_id') AS lease_id,
            json_extract(detail, '$.cost_usd') AS cost FROM audit
        WHERE team_id = ? AND action = 'residency.wake_cost' AND target = ? AND ts >= ?`,
    [teamId, seatName, nightStart],
  );
  let costUsd = 0;
  for (const c of costs) if (spent.has(c.lease_id) && typeof c.cost === 'number') costUsd += c.cost;
  return { count: spent.size, costUsd };
}

type SeatWakePolicy = ReturnType<typeof effectiveWakePolicy>;

/** What the read-only pass decided for one seat (ADR 576 §1): at most one wake, and the exhaustion
 *  rows its gates reached on the way. Nothing here has been written yet. */
interface SeatPass {
  member: MemberRow;
  policy: SeatWakePolicy;
  plan:
    | { kind: 'provisioned'; provisionId: string; sponsorName: string }
    | { kind: 'candidate'; candidate: WakeCandidate; edge: LoopEdge | null; exhKey: string }
    | { kind: 'dream' }
    | null;
  /** `once`: an attempt-cap row, written only while the act is not already exhausted (one terminal
   *  row per act). The edge-breaker rows are written on every pass that reaches them, as before. */
  exhausted: { entry: AuditEntry; once: boolean }[];
}

/**
 * Insert a lease unless the seat already holds a live one. `idx_wake_leases_one_live` (v94) is the
 * guarantee on every driver (ADR 576 §3); false means another poll got there first.
 */
async function insertLease(t: Driver, lease: WakeLeaseRow): Promise<boolean> {
  const { changes } = await t.run(
    `INSERT INTO wake_leases (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at, edge, spawned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [
      lease.id,
      lease.team_id,
      lease.member_id,
      lease.act_id,
      lease.lane_id,
      lease.host,
      lease.lane,
      lease.status,
      lease.created_at,
      lease.expires_at,
      lease.edge,
      lease.spawned_at,
    ],
  );
  return changes > 0;
}

/**
 * The host's poll (ADR 131 §4 as amended by ADR 576). Each enrolled seat's wake is worked out with
 * plain reads, outside any transaction, and then each seat that has one is rechecked and written in
 * its own short transaction. On a large team the derivation is hundreds of awaited statements, and
 * on SQLite every other write on the daemon queued behind it while it ran inside one transaction.
 */
export async function claimWakeLeases(
  db: Driver,
  teamId: string,
  teamSlug: string,
  host: string,
  presenceTimeoutMs: number,
  now = Date.now(),
  scope: HostScope = TEAM_WIDE_HOST,
): Promise<WakeOrder[]> {
  const passes = await deriveSeatPasses(db, teamId, teamSlug, host, presenceTimeoutMs, now, scope);
  const orders: WakeOrder[] = [];
  for (const pass of passes) {
    const order = await writeSeatPass(db, teamId, teamSlug, host, presenceTimeoutMs, now, pass);
    if (order) orders.push(order);
  }
  return orders;
}

/** ADR 576 §1: the derivation, unchanged in its gates and their order, with every write deferred. */
async function deriveSeatPasses(
  db: Driver,
  teamId: string,
  teamSlug: string,
  host: string,
  presenceTimeoutMs: number,
  now: number,
  scope: HostScope,
): Promise<SeatPass[]> {
  const passes: SeatPass[] = [];
  const reclaimable = await listReclaimableMemberIds(db, teamId, now);
  const enrollments = (await listResidency(db, teamId)).filter((r) => r.host === host);
  const teamPolicy = await getPolicy(db, teamId);
  // One ledger read for the whole poll, and only if some seat actually reaches the batched lane —
  // a team where every enrolled seat is on the interrupt lane, or is inside its cooldown, pays
  // nothing. Lazy rather than eager for exactly that case; memoised for exactly this poll.
  let ledgerMemo: ActDelivery[] | null = null;
  const teamLedger = async (): Promise<ActDelivery[]> =>
    (ledgerMemo ??= await openDirectedLedger(db, teamId));
  const reviewLoopOn = teamPolicy.loops?.review === true;
  const dispatchLoopOn = teamPolicy.loops?.dispatch === true;
  // ADR 271 §4 (built, lane 01M3TAM0X3): the incident wake knobs, read once per poll with the
  // rest of the team policy — both default off (ADR 271's posture), so an upgrade arms nothing.
  const wakeOnIncidentRoute = teamPolicy.incident?.wake_on_route === true;
  const wakeOnIncidentResolve = teamPolicy.incident?.wake_on_resolve === true;
  // ADR 494 §2: the Team's schedule, read once; a Member's own schedule replaces it (ADR 206).
  const teamHours = parseWorkingHours((await getTeamById(db, teamId))?.working_hours);
  for (const enrollment of enrollments) {
    const member = await getMemberById(db, enrollment.member_id);
    if (!member || member.left_at !== null) continue;
    // ADR 501: a halted seat is never handed to a host; its enrollment stays for resume.
    if (member.halted_at !== null && member.halted_at !== undefined) continue;
    // ADR 463 §1 (Review Focus 1): whatever else shares the host label, a key wakes only the
    // seats it may serve — a sponsored seat only from its sponsor's own key.
    if (!hostMayServe(scope, member)) continue;
    if (await hasLivePresence(db, member.id, presenceTimeoutMs)) continue;
    if (reclaimable.has(member.id)) continue;
    if (await liveLease(db, member.id, now)) continue;
    // Local-session guard snooze (increment 4): the host reported a live local session in this
    // seat's workspace — don't re-derive a lease every tick while someone is plainly working there.
    // ADR 485: a repeated local-session deferral backs off instead of re-deriving every 5 min.
    const snoozeUntil = await deferralSnoozeUntil(db, teamId, member.name);
    if (snoozeUntil !== null && now < snoozeUntil) continue;
    const policy = effectiveWakePolicy(seatWakeDefaults(teamPolicy, member), enrollment.policy);
    const pass: SeatPass = { member, policy, plan: null, exhausted: [] };
    passes.push(pass);
    // ADR 463 §2: a freshly provisioned seat's first wake — once, ahead of everything else, and
    // outside the rate gates (it is the seat's first wake, so they cannot have been spent).
    const provisioned = await db.get<{ id: string; sponsor_id: string }>(
      `SELECT id, sponsor_id FROM host_provisions WHERE team_id = ? AND member_id = ?
         AND state = 'ready' AND first_wake_at IS NULL ORDER BY ready_at ASC LIMIT 1`,
      [teamId, member.id],
    );
    if (provisioned) {
      const sponsorName = (await getMemberById(db, provisioned.sponsor_id))?.name ?? '?';
      pass.plan = { kind: 'provisioned', provisionId: provisioned.id, sponsorName };
      continue;
    }
    if ((await wakesSince(db, teamId, member.name, now - 3_600_000)) >= policy.hourly_cap) continue;

    const cooled = (await wakesSince(db, teamId, member.name, now - policy.cooldown_ms)) === 0;
    const candidates = await dueCandidates(
      db,
      teamSlug,
      member,
      {
        immediate: policy.lane !== 'batched',
        batched: cooled && policy.lane !== 'interrupt',
        raisedDeferralWakes: policy.raised_deferral_wakes,
        conveneHuddles: policy.convene_huddles,
        wakeOnIncidentRoute,
        wakeOnIncidentResolve,
      },
      teamLedger,
    );
    // ADR 199: dispatch work-orders (continuation then handoff — handoff unshifted last so it
    // leads). ADR 191: review work-orders prefer ahead of both + inbox.
    if (dispatchLoopOn && policy.flow === 'auto' && cooled) {
      candidates.unshift(
        ...(await dueDispatchContinuationWorkOrders(db, teamId, teamSlug, member)),
      );
      candidates.unshift(...(await dueDispatchHandoffWorkOrders(db, teamId, teamSlug, member)));
    }
    if (reviewLoopOn && policy.flow === 'auto' && cooled) {
      candidates.unshift(...(await dueReviewWorkOrders(db, teamId, teamSlug, member)));
    }
    // ADR 434 §c, read once per seat per poll and only when something is due.
    const horizon = candidates.length > 0 ? await wakeHorizon(db, teamId, member.name) : null;
    for (const candidate of candidates) {
      const exhKey = wakeExhaustionKey(candidate.act_id, candidate.lane_id);
      const edge = loopEdgeOf(candidate);
      // ADR 434, inbox wakes only (an edge-bearing work order is a lane fact, not an act):
      //  §c — an act received before the seat's fresh enrollment is not this enrollment's to
      //       wake for; §b — an act that already completed a wake is spent, unless someone else
      //       has since added to its thread. Both silent, like the still-true skip: a spent act
      //       is the resting state of an answered inbox, not an event.
      if (edge === null && candidate.act_id) {
        const received = await actReceivedAt(db, teamId, candidate.act_id);
        if (horizon !== null && received !== null && received < horizon) continue;
        const woke = await lastWokeForAct(db, teamId, member.name, candidate.act_id);
        if (
          woke !== null &&
          !(await threadReopenedSince(db, teamId, member.id, candidate.act_id, woke))
        )
          continue;
      }
      /**
       * ADR 306 §1. An edge-bearing work order is bounded by the ADR 262 (lane, edge) rules
       * below and by nothing else. The per-act cap does NOT apply to it, for two reasons the
       * live ledger showed on 2026-08-21:
       *
       *  - it counts `residency.woke` alongside `wake_failed` against a LIFETIME terminal row,
       *    so three SUCCESSFUL continuations exhausted a lane forever — the exact case ADR 262
       *    §4.1 promised would keep deriving, dead on two real lanes;
       *  - keyed `act_id` else `lane:<id>`, it is coarser than (lane, edge) at the same
       *    threshold of 3 while counting a SUPERSET of the rows. A subset counter behind a
       *    superset counter at an equal threshold is unreachable: the ADR 262 breaker fired
       *    zero times in eight days while five (lane, edge) pairs reached its threshold.
       *
       * Inbox wakes (edge NULL) are untouched — there a success SHOULD retire the act.
       */
      const edgeBound = edge !== null && candidate.lane_id !== undefined;
      if (!edgeBound) {
        if (await isExhausted(db, teamId, exhKey)) continue;
        if ((await attemptsForAct(db, teamId, exhKey)) >= policy.attempt_cap) {
          pass.exhausted.push({
            once: true,
            entry: {
              actor: null,
              action: 'residency.wake_exhausted',
              target: member.name,
              result: 'deny',
              detail: {
                act: exhKey,
                sender: candidate.sender ?? 'board',
                attempts: policy.attempt_cap,
                derivation: candidate.derivation,
                ...(candidate.lane_id !== undefined ? { lane_id: candidate.lane_id } : {}),
              },
            },
          });
          continue;
        }
      }
      if (edge && candidate.lane_id) {
        if (
          (await workOrderEdgeFailureCount(db, teamId, candidate.lane_id, edge)) >=
          WORK_ORDER_EDGE_BREAKER_N
        ) {
          pass.exhausted.push({
            once: false,
            entry: {
              actor: null,
              action: 'residency.wake_exhausted',
              target: member.name,
              result: 'deny',
              detail: {
                act: exhKey,
                edge,
                lane_id: candidate.lane_id,
                breaker: true,
                attempts: WORK_ORDER_EDGE_BREAKER_N,
                derivation: candidate.derivation,
              },
            },
          });
          continue;
        }
        if (await workOrderEdgeStillTrue(db, teamId, candidate.lane_id, edge)) continue;
        if (edge === 'dispatch_continuation') {
          // ADR 306 §3 — the succeeding chain has a ceiling too.
          if (
            (await workOrderEdgeWokeCount(db, teamId, candidate.lane_id, edge)) >=
            WORK_ORDER_CONTINUATION_SUCCESS_CAP
          ) {
            pass.exhausted.push({
              once: false,
              entry: {
                actor: null,
                action: 'residency.wake_exhausted',
                target: member.name,
                result: 'deny',
                detail: {
                  act: exhKey,
                  edge,
                  lane_id: candidate.lane_id,
                  reason: 'continuation_cap',
                  attempts: WORK_ORDER_CONTINUATION_SUCCESS_CAP,
                  derivation: candidate.derivation,
                },
              },
            });
            continue;
          }
          // ADR 306 §2 — a wake that moved nothing does not buy the next one. Silent, like the
          // still-true skip: a stalled lane is the normal resting state of a claimed board, not
          // an event worth a row on every poll.
          if (!(await laneMovedSinceLastWoke(db, teamId, candidate.lane_id, edge))) continue;
        }
      }
      pass.plan = { kind: 'candidate', candidate, edge, exhKey };
      break; // one lease per seat per poll
    }
    // ADR 494: nothing asked-for was leased, so the seat may be due a dream — idle (the live
    // presence and deferral-snooze gates above already passed), cooled, outside its working
    // hours, inside tonight's count and budget. A dream never shares a pass with another wake.
    if (pass.plan === null && policy.dream_enabled && cooled) {
      const hours = parseWorkingHours(member.working_hours) ?? teamHours;
      const nightStart = hours ? lastWorkingDayEnd(hours, now) : null;
      const night =
        nightStart === null
          ? { count: 0, costUsd: 0 }
          : await dreamNight(db, teamId, member.name, nightStart);
      const blocker = dreamBlocker({
        enabled: policy.dream_enabled,
        enrolled: true,
        live: false,
        otherWakeDue: false,
        hours,
        now,
        dreamsTonight: night.count,
        nightlyWakes: policy.dream_nightly_wakes,
        costTonightUsd: night.costUsd,
        ...(policy.dream_budget_usd !== undefined ? { budgetUsd: policy.dream_budget_usd } : {}),
      });
      if (blocker === null) pass.plan = { kind: 'dream' };
    }
  }
  return passes.filter((p) => p.plan !== null || p.exhausted.length > 0);
}

/**
 * ADR 576 §2: one seat's writes, in a transaction a few statements long. The seat is rechecked for
 * the facts its wake depends on — still offline, still no live lease, the provisioned first wake
 * still untaken — and dropped for this poll if any has changed; the next poll derives it again.
 */
async function writeSeatPass(
  db: Driver,
  teamId: string,
  teamSlug: string,
  host: string,
  presenceTimeoutMs: number,
  now: number,
  pass: SeatPass,
): Promise<WakeOrder | null> {
  const { member, policy, plan } = pass;
  return db
    .tx(async (t): Promise<WakeOrder | null> => {
      for (const { entry, once } of pass.exhausted) {
        if (once && (await isExhausted(t, teamId, String(entry.detail?.act)))) continue;
        await appendAudit(t, teamId, entry);
      }
      if (plan === null) return null;
      if (await hasLivePresence(t, member.id, presenceTimeoutMs)) return null;
      if (await liveLease(t, member.id, now)) return null;
      if (plan.kind === 'provisioned') {
        const { changes } = await t.run(
          'UPDATE host_provisions SET first_wake_at = ? WHERE id = ? AND first_wake_at IS NULL',
          [now, plan.provisionId],
        );
        if (changes === 0) return null;
      }
      const candidate = plan.kind === 'candidate' ? plan.candidate : null;
      const edge = plan.kind === 'candidate' ? plan.edge : null;
      const lane: WakeLane =
        plan.kind === 'provisioned'
          ? 'immediate'
          : plan.kind === 'dream'
            ? 'batched'
            : candidate!.lane;
      const lease: WakeLeaseRow = {
        id: ulid(),
        team_id: teamId,
        member_id: member.id,
        act_id: candidate?.act_id ?? null,
        lane_id: candidate?.lane_id ?? null,
        host,
        lane,
        status: 'leased',
        created_at: now,
        expires_at: now + WAKE_LEASE_TTL_MS,
        edge,
        spawned_at: null,
      };
      if (!(await insertLease(t, lease))) {
        // The insert lost to a concurrent poll, so the provision mark above must not stand.
        if (plan.kind === 'provisioned') throw new LeaseLost();
        return null;
      }
      const bounds = (timeoutMs: number) => ({
        timeout_ms: timeoutMs,
        ...(policy.max_turns !== undefined ? { max_turns: policy.max_turns } : {}),
        ...(policy.budget_usd !== undefined ? { budget_usd: policy.budget_usd } : {}),
      });
      if (plan.kind === 'provisioned') {
        await appendAudit(t, teamId, {
          actor: null,
          action: 'residency.wake_leased',
          target: member.name,
          result: 'allow',
          detail: {
            lease_id: lease.id,
            reason: 'provisioned',
            provision_id: plan.provisionId,
            sponsor: plan.sponsorName,
            lane: 'immediate',
            host,
            derivation: 'immediate',
          },
        });
        return {
          lease_id: lease.id,
          seat: member.name,
          lane: 'immediate',
          composed_line: composeProvisionedLine(member.name, teamSlug, plan.sponsorName),
          expires_at: lease.expires_at,
          tool_policy: policy.tool_policy,
          bounds: bounds(policy.timeout_ms),
          transcript_max_bytes: policy.transcript_max_bytes,
          continuity_requirement: 'portable',
          intended_delivery: 'fresh',
          derivation: 'immediate',
          reason: 'provisioned',
        };
      }
      if (plan.kind === 'dream') {
        await appendAudit(t, teamId, {
          actor: null,
          action: 'residency.wake_leased',
          target: member.name,
          result: 'allow',
          detail: {
            lease_id: lease.id,
            act: 'dream',
            sender: 'dream',
            lane: 'batched',
            host,
            derivation: 'dream',
            continuity_requirement: 'portable',
            intended_delivery: 'fresh',
          },
        });
        return {
          lease_id: lease.id,
          seat: member.name,
          lane: 'batched',
          composed_line: composeDreamLine(member.name, teamSlug),
          expires_at: lease.expires_at,
          // A dream writes wiki pages and opens a PR, so it runs under the seat's own tool
          // policy; the write fence (store/dream.ts) is what keeps it to memory.
          tool_policy: 'seat-policy',
          bounds: bounds(policy.work_timeout_ms),
          transcript_max_bytes: policy.transcript_max_bytes,
          // ADR 494 §3: always fresh — a dream re-reads the record, it never resumes a life.
          continuity_requirement: 'portable',
          intended_delivery: 'fresh',
          derivation: 'dream',
        };
      }
      const c = plan.candidate;
      const isPortable = isPortableWakeCandidate(c, policy.portable_inbox_replies);
      const resumeEligible = isResumeEligible(c, policy, now);
      await appendAudit(t, teamId, {
        actor: null,
        action: 'residency.wake_leased',
        target: member.name,
        result: 'allow',
        detail: {
          lease_id: lease.id,
          act: plan.exhKey,
          sender: c.sender ?? 'board',
          lane: c.lane,
          host,
          derivation: c.derivation,
          ...(isPortable ? { continuity_requirement: 'portable', intended_delivery: 'fresh' } : {}),
          // ADR 210: the eligibility BIT is audited; the thread id that produced it is not. The
          // ledger records that a resume was permitted, never anything about the local session.
          ...(resumeEligible ? { resume_eligible: true } : {}),
          ...(c.lane_id !== undefined ? { lane_id: c.lane_id } : {}),
          ...(edge !== null ? { edge } : {}),
        },
      });
      const isWorkOrder = c.derivation === 'work_order';
      const kind = c.work_order_kind ?? 'dispatch';
      return {
        lease_id: lease.id,
        seat: member.name,
        ...(c.act_id !== undefined ? { act_id: c.act_id } : {}),
        ...(c.act !== undefined ? { act: c.act } : {}),
        ...(c.sender !== undefined ? { sender: c.sender } : {}),
        lane: c.lane,
        composed_line: isWorkOrder
          ? composeWorkOrderLine(member.name, teamSlug, c.lane_id!, kind, c.act_id)
          : composeWakeLine(member.name, teamSlug, c.act ?? 'message', c.sender ?? '?', c.act_id),
        expires_at: lease.expires_at,
        tool_policy: isWorkOrder ? 'seat-policy' : policy.tool_policy,
        bounds: bounds(isWorkOrder ? policy.work_timeout_ms : policy.timeout_ms),
        transcript_max_bytes: policy.transcript_max_bytes,
        ...(isPortable
          ? { continuity_requirement: 'portable' as const, intended_delivery: 'fresh' as const }
          : {}),
        // The mark and the key it needs travel together: an eligible wake carries the thread id
        // so the host can look for an exact local binding. Never audited, never returned.
        ...(resumeEligible ? { resume_eligible: true as const, thread_id: c.thread_id! } : {}),
        derivation: c.derivation,
        ...(c.lane_id !== undefined ? { lane_id: c.lane_id } : {}),
      };
    })
    .catch((e: unknown) => {
      if (e instanceof LeaseLost) return null;
      throw e;
    });
}

/** Rolls back a provisioned wake whose lease insert lost the race, so its first wake stays due. */
class LeaseLost extends Error {}

/**
 * Settle a lease from the host's `WakeOutcome` report. `leased` (or `expired` — a slow-but-honest
 * report after the reaper gave up on it) transitions to `reported`; returns the lease row or null
 * for unknown/already-reported (the caller 404s/409s). The route writes the outcome audit
 * (`residency.woke` / `residency.wake_failed`) — this only settles the stored bit.
 */
export async function settleWakeLease(
  db: Driver,
  teamId: string,
  leaseId: string,
): Promise<WakeLeaseRow | null> {
  const row = await db.get<WakeLeaseRow>('SELECT * FROM wake_leases WHERE team_id = ? AND id = ?', [
    teamId,
    leaseId,
  ]);
  if (!row || row.status === 'reported') return null;
  await db.run("UPDATE wake_leases SET status = 'reported' WHERE id = ?", [row.id]);
  return row;
}

/** Stamp spawned_at if null. Returns the lease row, or null if unknown id. Never settles. */
export async function markWakeSpawned(
  db: Driver,
  teamId: string,
  leaseId: string,
  now = Date.now(),
): Promise<WakeLeaseRow | null> {
  const row = await db.get<WakeLeaseRow>('SELECT * FROM wake_leases WHERE team_id = ? AND id = ?', [
    teamId,
    leaseId,
  ]);
  if (!row) return null;
  if (row.spawned_at === null) {
    await db.run('UPDATE wake_leases SET spawned_at = ? WHERE id = ?', [now, row.id]);
    row.spawned_at = now;
  }
  return row;
}

/** One captured native-loop turn (ADR 251 §7), read back with usage/transcript deserialized. */
export interface WakeTurnRow {
  lease_id: string;
  member_id: string;
  turn: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | undefined;
    cache_creation_input_tokens?: number | undefined;
  };
  cost_usd: number | null;
  stop_reason: string | null;
  transcript: unknown;
  created_at: number;
}

/**
 * Append one native-loop turn against a lease (ADR 251 §7). The lease may be in ANY status —
 * `outcome` settles at verification while the loop runs on, so most turns land on a `reported`
 * lease. Idempotent per (lease, turn): a retried post overwrites. Returns null for an unknown
 * lease (the route 404s).
 */
export async function appendWakeTurn(
  db: Driver,
  teamId: string,
  body: {
    lease_id: string;
    turn: number;
    usage: WakeTurnRow['usage'];
    cost_usd?: number | undefined;
    stop_reason?: string | undefined;
    transcript?: unknown;
  },
  now = Date.now(),
): Promise<{ member_id: string } | null> {
  const lease = await db.get<{ member_id: string }>(
    'SELECT member_id FROM wake_leases WHERE team_id = ? AND id = ?',
    [teamId, body.lease_id],
  );
  if (!lease) return null;
  await db.run(
    `INSERT INTO wake_turns (id, team_id, lease_id, member_id, turn, usage_json, cost_usd, stop_reason, transcript_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lease_id, turn) DO UPDATE SET
       usage_json = excluded.usage_json,
       cost_usd = excluded.cost_usd,
       stop_reason = excluded.stop_reason,
       transcript_json = excluded.transcript_json,
       created_at = excluded.created_at`,
    [
      ulid(),
      teamId,
      body.lease_id,
      lease.member_id,
      body.turn,
      JSON.stringify(body.usage),
      body.cost_usd ?? null,
      body.stop_reason ?? null,
      body.transcript === undefined ? null : JSON.stringify(body.transcript),
      now,
    ],
  );
  return { member_id: lease.member_id };
}

/** The captured turns for one lease, in turn order — the resume substrate and the cost ledger. */
export async function listWakeTurns(
  db: Driver,
  teamId: string,
  leaseId: string,
): Promise<WakeTurnRow[]> {
  return (
    await db.all<{
      lease_id: string;
      member_id: string;
      turn: number;
      usage_json: string;
      cost_usd: number | null;
      stop_reason: string | null;
      transcript_json: string | null;
      created_at: number;
    }>('SELECT * FROM wake_turns WHERE team_id = ? AND lease_id = ? ORDER BY turn ASC', [
      teamId,
      leaseId,
    ])
  ).map((r) => ({
    lease_id: r.lease_id,
    member_id: r.member_id,
    turn: r.turn,
    usage: JSON.parse(r.usage_json) as WakeTurnRow['usage'],
    cost_usd: r.cost_usd,
    stop_reason: r.stop_reason,
    transcript: r.transcript_json === null ? null : (JSON.parse(r.transcript_json) as unknown),
    created_at: r.created_at,
  }));
}

/**
 * Expire live leases past `expires_at` (the reaper, mirroring `expireRequests`). Returns the expired
 * rows so the reaper can CLASSIFY each one (ADR 236): a host that was up and did not report burns
 * attempt budget as `residency.wake_failed {reason: 'lease_expired'}` (else a host that dies
 * mid-spawn would retry forever); a host that was not there at all defers instead. Either way the
 * act re-becomes due, still bounded by the derived rate policy.
 */
/** Teams with at least one residency enrollment — who a host suspension concerns (ADR 236). */
export async function listResidencyTeamIds(db: Driver): Promise<string[]> {
  return (await db.all<{ team_id: string }>('SELECT DISTINCT team_id FROM residency')).map(
    (r) => r.team_id,
  );
}

/**
 * Milliseconds the daemon was demonstrably ABSENT within `[from, to]` — the sum of every recorded
 * `residency.host_suspended` interval clipped to that window (ADR 236). Derived from the ledger, in
 * the ADR 131 §4 shape: the audit rows ARE the state, and they survive a daemon restart, which
 * in-memory tick bookkeeping does not.
 *
 * Pinned to rows THIS machine minted (ADR 371 §4): `residency.host_suspended` replicates now, and a
 * suspension is a fact about the host that slept — folding a peer's into this ceiling would make
 * the hub believe it was asleep while a laptop's lid was shut. The same pin on `firstWakeLeaseTs`
 * and `leaseCapturedSession` below: a lease is host-scoped by construction (ADR 361).
 */
export async function hostAsleepMs(
  db: Driver,
  teamId: string,
  from: number,
  to: number,
): Promise<number> {
  // The outer CAST: SUM over 64-bit values is `numeric` on Postgres and comes back as a string;
  // cast to the integer type both engines return as a number.
  const row = await db.get<{ ms: number }>(
    `SELECT CAST(COALESCE(SUM(MAX(0,
                MIN(CAST(json_extract(detail, '$.to') AS INTEGER), ?)
                - MAX(CAST(json_extract(detail, '$.from') AS INTEGER), ?))), 0) AS INTEGER) AS ms
         FROM audit
        WHERE team_id = ? AND action = 'residency.host_suspended' AND ts >= ? ${MINTED_HERE}`,
    [to, from, teamId, from],
  );
  return row?.ms ?? 0;
}

/** Host-awake milliseconds since `since` (ADR 236): elapsed time minus every recorded suspension. */
export async function awakeMsSince(
  db: Driver,
  teamId: string,
  since: number,
  now: number,
): Promise<number> {
  return Math.max(0, now - since - (await hostAsleepMs(db, teamId, since, now)));
}

/** When this act was FIRST leased for actuation, from the ledger — the ceiling's clock start. */
export async function firstWakeLeaseTs(
  db: Driver,
  teamId: string,
  actKey: string,
): Promise<number | null> {
  const row = await db.get<{ ts: number }>(
    `SELECT MIN(ts) AS ts FROM audit
        WHERE team_id = ? AND action = 'residency.wake_leased'
          AND json_extract(detail, '$.act') = ? ${MINTED_HERE}`,
    [teamId, actKey],
  );
  return row?.ts ?? null;
}

/**
 * Did a session ever attest that it was spawned by this lease (ADR 252)? The join is by IDENTITY —
 * the `MUSTERD_WAKE_LEASE` token the actuator stamps on the woken child, carried through the
 * session attestation onto `residency.session_captured` — never by timing, which would re-admit the
 * "any fresh presence is my evidence" inference ADR 238→241 spent two increments removing.
 *
 * **True is evidence; false is silence.** A pre-ADR-252 CLI attests no token, so a `false` here
 * means "no session claimed this lease", not "no session ran". Every counter derived from this must
 * read as a floor.
 */
export async function leaseCapturedSession(
  db: Driver,
  teamId: string,
  leaseId: string,
): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
        WHERE team_id = ? AND action = 'residency.session_captured'
          AND json_extract(detail, '$.wake_lease') = ? ${MINTED_HERE}`,
    [teamId, leaseId],
  );
  return (row?.n ?? 0) > 0;
}

export async function expireWakeLeases(db: Driver, now = Date.now()): Promise<WakeLeaseRow[]> {
  const rows = await db.all<WakeLeaseRow>(
    "SELECT * FROM wake_leases WHERE status = 'leased' AND expires_at < ?",
    [now],
  );
  if (rows.length > 0) {
    await db.run(
      "UPDATE wake_leases SET status = 'expired' WHERE status = 'leased' AND expires_at < ?",
      [now],
    );
  }
  return rows;
}
