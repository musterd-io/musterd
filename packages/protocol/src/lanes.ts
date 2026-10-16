import { z } from 'zod';
import { ClaimCheckSchema } from './claimCheck.js';
import { LaneClaimsSchema } from './claims.js';
import { GoalSchema } from './goals.js';
import { HoldSchema } from './holds.js';
import {
  EMPTY_POOL_KINDS,
  EMPTY_POOL_LIVE_EXCLUSIONS,
  LANE_STAKES,
  LANE_STAKES_PROVENANCE,
  LANE_STATES,
  type EmptyPool,
  type LaneState,
} from './lanes.wire.js';
import { ReviewPromiseClosureRowSchema, ReviewPromiseOpenRowSchema } from './review-promise.js';
import { SEED_SOURCES } from './seeds.wire.js';
import { OwnDisputeRowSchema } from './sycophancy.js';

/**
 * Coordination lanes, Phase 1 (ADR 083) — the { work-item × owner × scope } unit that makes
 * work-ownership contention-aware. Declarations only in P1: `scope` + `depends_on` are the
 * whole engine; the two checks (unmet dependency, scope overlap) are **warn-only, never blocking**,
 * and git is optional throughout (`branch` is just a carried artifact label).
 */

/**
 * Lane lifecycle. `open` = unowned (claimable); `blocked`/`abandoned` are side states.
 * `awaiting_acceptance` (ADR 192; was `ready_for_review` in ADR 169) is the worker's "technically
 * complete" claim after merge — still contending (the surface stays owned until a counterpart
 * *accepts the outcome*), never terminal. `done` is the only success-terminal state; accepted-ness
 * is *derived* from the closing act's author vs the owner at close time (pinned in the
 * `lane.closed` audit row as `verified`), never stored.
 */
/**
 * The unscoped project — what a lane opened outside a git repo carries, and what every lane opened
 * before derivation existed carries. It is deliberately **wildcard** in the overlap check: an
 * unscoped lane contends with every project, and every project contends with it. A warning system
 * should fail toward a false positive, and this is what keeps a mixed-era board honest — legacy
 * lanes keep warning against everything, and the noise disappears on its own as they close.
 */
export const DEFAULT_PROJECT = 'default';

/** The lane vocabulary itself is validator-free (`lanes.wire.js`); this module is its zod face. */
export {
  ACCEPTANCE_MOVES_NOTICE,
  ACCEPTANCE_STALE_MS,
  AREA_PATH_SEGMENTS,
  deriveLaneAreas,
  LANE_AREAS,
  LANE_STAKES,
  LANE_STAKES_PROVENANCE,
  LANE_STATES,
  MERGE_VERIFICATION_TIERS,
  EMPTY_POOL_KINDS,
  EMPTY_POOL_LIVE_EXCLUSIONS,
  emptyPoolFromCandidates,
  isAwaitingAcceptance,
  laneAckAck,
  laneEscalationAck,
  laneSupersededAck,
  laneVerdictAck,
  type EmptyPool,
  type LaneArea,
  type LaneEscalationAck,
  type LaneEscalationWire,
  type LaneSupersededAck,
  type LaneSupersededWire,
  type EmptyPoolKind,
  type EmptyPoolLiveExclusion,
  type EmptyPoolLiveSeat,
  type LaneStakes,
  type LaneStakesProvenance,
  type LaneAckAck,
  type LaneState,
  type LaneVerdictAck,
  type MergeVerification,
} from './lanes.wire.js';

/** ADR 612: the three counts a submit sends beside its change class. */
export const ChangedCountsSchema = z.object({
  docs: z.number().int().nonnegative(),
  tests: z.number().int().nonnegative(),
  code: z.number().int().nonnegative(),
});

/**
 * Declared stakes for acceptance (ADR 234) — an ordered ladder, cheapest first.
 *
 * - `low` — the worker judges this not worth pulling someone off their lane for.
 * - `normal` — the default, and what every lane written before ADR 234 is read as.
 * - `high` — worth an interruption; risky surfaces (enforcement, protocol, data integrity).
 *
 * Increment 1 records the declaration and nothing reads it. What it buys is the ability to ask
 * whether declared stakes predict the answer rate **before** anything is built on the assumption
 * that they do. If they do not, the routing flip is aimed at nothing and should not ship.
 */
export const LaneStakesSchema = z.enum(LANE_STAKES);

/** Who set a lane's stakes (ADR 244) — see {@link LaneSchema.shape.stakes_provenance}. */
export const LaneStakesProvenanceSchema = z.enum(LANE_STAKES_PROVENANCE);

/**
 * One admin-set default-stakes rule (ADR 244): lanes whose declared surface lies entirely under
 * `surface` open at `stakes` unless the worker says otherwise.
 *
 * This is the surface-path rule ADR 234 rejected, and it is admissible now for one reason worth
 * stating rather than sliding past: ADR 234 rejected the system **inferring** value from a diff,
 * because surface complexity predicts review COST, not review VALUE. An admin declaring "on my team,
 * web lanes start low" is not an inference — it is an accountable human making a revocable,
 * attributable, visible choice, which is the kind of judgement ADR 234 wants stakes to carry. The
 * rule did not change; the actor did.
 */
export const StakesDefaultSchema = z.object({
  /**
   * A surface prefix, written as a glob for readability (`packages/web/**`). Matched as a PREFIX,
   * not by a glob engine — a predictable rule an admin can reason about beats an expressive one they
   * cannot, and this value silently changes who reviews their team's work.
   */
  surface: z.string().min(1),
  stakes: LaneStakesSchema,
});
export type StakesDefault = z.infer<typeof StakesDefaultSchema>;

/**
 * Does this policy give the lane a default, and which? First match wins, so an admin can order
 * specific rules ahead of broad ones.
 *
 * **Every** declared glob must fall under the rule, not merely one — and that asymmetry is the
 * safety property. A lane touching `packages/web/**` AND `packages/server/**` is not a web lane; if
 * `any` matched, a worker could exempt a server change by mentioning a web file beside it, and the
 * exemption would be one glob away from anything. A lane declaring NO surface matches nothing and
 * keeps `normal`: a lane that did not say where it works has not earned a surface-based default.
 */
export function resolveStakesDefault(
  rules: readonly StakesDefault[],
  scope: readonly string[],
): StakesDefault | undefined {
  if (scope.length === 0) return undefined;
  return rules.find((rule) => {
    // `packages/web/**`, `packages/web/` and `packages/web` all mean "under packages/web". Normalize
    // to a prefix ending at a path boundary: without that last step `packages/web` also matches
    // `packages/webhooks`, and an admin who wrote the shortest legible form would silently widen
    // their own rule across a sibling package. A rule that changes who reviews the team's work has
    // to mean exactly what it looks like it means.
    const prefix = rule.surface.replace(/\*+$/, '').replace(/\/$/, '') + '/';
    return scope.every((g) => g.startsWith(prefix));
  });
}

export const LaneStateSchema = z.enum(LANE_STATES);

/**
 * Scopes that render for a human. A lane that touches one of these and is opened with no explicit
 * `risk` gets `risk: []` from the schema default — which silently skips the ADR 188 two-stage
 * human gate, even when the lane's axis 4 (Feel — a human's read of a rendered surface) is the
 * whole acceptance question. A lane whose scope is one of these must declare its risk, or declare
 * the lack of one; it must not inherit a default it never chose.
 *
 * Matched by prefix, like StakesDefault: a scope path starts with one of these roots. The author
 * still declares the tag — this only says *a declaration is required*.
 */
export const HUMAN_VISIBLE_SCOPE_ROOTS: readonly string[] = ['packages/web/', 'packages/mobile/'];

/** Must this scope declare `risk` at open (ADR 530)? The declaration is not itself the human gate (ADR 631). */
export function scopeIsHumanVisible(scope: readonly string[] | undefined): boolean {
  if (!scope) return false;
  return scope.some((glob) =>
    HUMAN_VISIBLE_SCOPE_ROOTS.some((root) => {
      const norm = root.replace(/\/+$/, '');
      // A bare `--surface packages/web` is still the web surface; prefix-match only at a path
      // boundary so `packages/webhooks` is not caught by the `packages/web` root.
      return glob === norm || glob.startsWith(`${norm}/`);
    }),
  );
}

/**
 * The tag that means "a person will see this" (ADR 530's example, ADR 631's exemption).
 * Any other declared tag still requires a human.
 */
export const USER_FACING_RISK_TAG = 'user-facing';

/**
 * Code files plus doc files on the landed diff. Tests do not count. At or above this, a
 * `user-facing` lane still asks a human (ADR 631, "changes a lot"). 25 sits above every
 * user-facing landing that had a recorded count on 2026-10-16; the largest of those was 12.
 */
export const USER_FACING_LARGE_DIFF_FILES = 25;

/**
 * Does this lane's acceptance owe a human (ADR 172, narrowed by ADR 631)?
 *
 * A tag other than `user-facing` does — security, production, destructive, and the rest.
 * `user-facing` alone does not: a peer accept closes it. It does again when the author
 * declared the change big (`stakes: high`) or the landed diff is large. Counts that were
 * never recorded are not large. An empty risk list is not a human review.
 */
export function humanReviewRequired(lane: {
  risk?: readonly string[] | null | undefined;
  stakes?: string | null | undefined;
  // `| undefined` is load-bearing. exactOptionalPropertyTypes treats an explicit
  // `changed: undefined` as a different type from an absent field, and a Lane carries
  // the explicit form.
  merged?:
    | {
        changed?:
          | { docs?: number | null | undefined; code?: number | null | undefined }
          | null
          | undefined;
      }
    | null
    | undefined;
}): boolean {
  const risk = lane.risk ?? [];
  if (risk.some((tag) => tag !== USER_FACING_RISK_TAG)) return true;
  if (!risk.includes(USER_FACING_RISK_TAG)) return false;
  if (lane.stakes === 'high') return true;
  const changed = lane.merged?.changed;
  if (!changed) return false;
  const docs = changed.docs ?? 0;
  const code = changed.code ?? 0;
  if (!Number.isSafeInteger(docs) || !Number.isSafeInteger(code) || docs < 0 || code < 0) {
    return false;
  }
  return docs + code >= USER_FACING_LARGE_DIFF_FILES;
}

/**
 * Why a lane's close landed the way it did (ADR 283) — the vocabulary the `lane.closed` audit row
 * has recorded since ADR 217/229/234, lifted onto the wire so a reader can act on it.
 *
 * The order is the ladder `laneClose.ts` walks, and the grouping is the one that matters to a
 * reader: the first two are settled outcomes, the middle three mean NOBODY WAS ASKED, and the last
 * three mean SOMEBODY WAS ASKED AND DID NOT ANSWER. Any new member must be added deliberately —
 * an unrecognised value is dropped by the projection rather than passed through, so a future
 * daemon's vocabulary degrades to "unknown" instead of leaking a string this build cannot explain.
 */
export const CloseReasonSchema = z.enum([
  /** A counterpart accepted it. The only reason that means `verified: true`. */
  'counterpart_confirm',
  /** The owner closed their own lane, no acceptance stage involved. */
  'self_close',
  /** Never entered acceptance: declared `low` stakes and not drawn into the sample (ADR 234). */
  'acceptance_exempt',
  /** The picker found no eligible counterpart — the sanctioned degradation (ADR 172). */
  'no_candidate',
  /** A risk tag REQUIRED a human and none was live — a requirement with no one to meet it. */
  'human_review_missed',
  /** Asked, and the wait ran past the promise (ADR 217). */
  'review_timeout',
  /** Asked, and the owner closed it themselves before the promise elapsed (ADR 217). */
  'review_cut_short',
  /** Asked, and the promise itself was never knowable — abstains on the elapsed claim (ADR 217). */
  'review_unanswered',
  /** The ADR 229 24h sweep closed it. The clock, not a seat — see `ask_outcome` on the audit row. */
  'review_swept',
  /** Abandoned rather than shipped. */
  'abandoned',
]);
export type CloseReason = z.infer<typeof CloseReasonSchema>;

/**
 * ADR 518: how a lane's acceptance was routed at submit — the `lane.ready_for_review` audit row's
 * `review_selection.outcome` (ADR 303), surfaced on the board as `acceptance_route`. Projection-only.
 */
export const AcceptanceRouteSchema = z.enum([
  'peer_selected',
  'human_fallback',
  'wake_queued',
  'no_candidate',
  'acceptance_exempt',
]);
export type AcceptanceRoute = z.infer<typeof AcceptanceRouteSchema>;

/**
 * What to TELL a reader about an unaccepted close (ADR 283), or `null` where the reason adds
 * nothing to the word already on screen.
 *
 * Copy lives here, once, for the same reason the derivation does (ADR 084): the board, the brief,
 * and the CLI drifted apart on `verified` for two ADRs, and the fix was one projection rather than
 * three renderers agreeing by luck. Each phrase is written to imply its OWN next move — the
 * distinction is only worth a wire field if a reader can act differently on each half, so "chase a
 * person" and "look at the roster" have to be legible from the sentence alone.
 *
 * `counterpart_confirm` and `abandoned` return `null`: the first is what `accepted` already says,
 * and the second is already the whole story. Repeating them would make the annotation noise on the
 * majority of lanes and train readers to skip it on the minority where it carries the news.
 */
export function closeReasonCopy(reason: CloseReason): string | null {
  switch (reason) {
    case 'counterpart_confirm':
    case 'abandoned':
      return null;
    case 'self_close':
      return 'closed by its own owner';
    case 'acceptance_exempt':
      return 'no ask sent, by design — declared low stakes';
    case 'no_candidate':
      return 'nobody was asked — no eligible counterpart';
    case 'human_review_missed':
      return 'nobody was asked — the required human was never live';
    case 'review_timeout':
      return 'asked, and the wait ran out';
    case 'review_cut_short':
      return 'asked, then closed before the wait elapsed';
    case 'review_unanswered':
      return 'asked, and never answered';
    case 'review_swept':
      return 'swept by the 24h clock, not by a seat';
  }
}

export const EmptyPoolLiveSeatSchema = z.object({
  member: z.string().min(1),
  exclusion: z.enum(EMPTY_POOL_LIVE_EXCLUSIONS),
});
export const EmptyPoolSchema = z.object({
  kind: z.enum(EMPTY_POOL_KINDS),
  live: z.array(EmptyPoolLiveSeatSchema).optional(),
});

/**
 * Worker-facing distinction for a submit that asked nobody (ADR 404). The sanction sentence is
 * the caller's; this is only why the pool was empty.
 */
export function emptyPoolCopy(pool: EmptyPool): string {
  if (pool.kind === 'no_live_member') return 'no other member is live';
  const groups = new Map<string, string[]>();
  for (const row of pool.live ?? []) {
    const names = groups.get(row.exclusion) ?? [];
    names.push(row.member);
    groups.set(row.exclusion, names);
  }
  const bits = [...groups.entries()].map(([ex, names]) => `${ex}: ${names.join(', ')}`);
  return bits.length > 0
    ? `live seats were ineligible (${bits.join('; ')})`
    : 'live seats were ineligible';
}

/**
 * Client copy for a no-ask submit. Older daemons omit `empty_pool`; keep the historical sentence
 * rather than inventing a kind we did not observe.
 */
export function emptyPoolHint(pool: EmptyPool | undefined | null): string {
  return pool ? emptyPoolCopy(pool) : 'no eligible acceptor is live';
}

/** True when the lane is in the post-merge outcome-acceptance stage (ADR 192), either spelling. */
// `isAwaitingAcceptance` and `ACCEPTANCE_STALE_MS` live in `lanes.wire.js`; re-exported below.

/** Canonical state to write when entering outcome acceptance (ADR 192). */
export const AWAITING_ACCEPTANCE: LaneState = 'awaiting_acceptance';

/**
 * The two semantic state sets (ADR 169 consolidation — previously three hand-kept copies across
 * store/transport/MCP, which a new state would have tripled into drift).
 * Contending: an owned/worked lane whose surface participates in overlap warnings and the ADR 150
 * Gate A edit-guard — includes outcome acceptance (owned until accepted). Terminal: the lane's
 * active life is over.
 */
export const LANE_CONTENDING_STATES: ReadonlySet<LaneState> = new Set([
  'claimed',
  'active',
  'blocked',
  'awaiting_acceptance',
  'ready_for_review',
]);
export const LANE_TERMINAL_STATES: ReadonlySet<LaneState> = new Set(['done', 'abandoned']);

// ADR 296 tier 2's `surface_globs` wire mirror (dual-send + dual-populate for one-epoch skew) was
// dropped at epoch 16, on-touch, with the fleet verified at 14 — `scope` is the only wire token.

/**
 * Why a lane is parked (ADR 466) — set as a unit on the move into `parked`, cleared on the move out.
 * `reason` is required so the next reader knows what "later" waits on. `until` is advisory: shown,
 * never a timer — nothing unparks a lane on its own, because re-offering shelved work is the failure
 * the state exists to prevent.
 */
export const LaneParkSchema = z.object({
  /** The human Member who parked it (only humans park or unpark). */
  by: z.string(),
  at: z.number().int(),
  reason: z.string().min(1).max(280),
  until: z.number().int().optional(),
});
export type LanePark = z.infer<typeof LaneParkSchema>;

/**
 * ADR 624: how a lane-picker pick reached the daemon, and how strongly "who asked" is proven.
 * `attested` is true only when the patch's actor IS `requested_by` (a /live handoff from the
 * signed-in human). A seat claiming for itself — a terminal pick — is never attested; the daemon
 * refuses one that says so.
 */
export const PickSchema = z.object({
  via: z.enum(['terminal', 'live']),
  requested_by: z.string().min(1).max(64),
  attested: z.boolean(),
  harness: z.string().max(32).optional(),
  at: z.number().int(),
});
export type Pick = z.infer<typeof PickSchema>;

/** ADR 624: the most recent decline — a release that gave a reason. Any later claim clears it. */
export const LaneDeclinedSchema = z.object({
  by: z.string(),
  reason: z.string().max(500),
  at: z.number().int(),
});
export type LaneDeclined = z.infer<typeof LaneDeclinedSchema>;

/**
 * What a closing lane says is left (ADR 487 §5.1): `"none"`, or the lanes that carry the rest — each
 * an existing lane in any state. Answered on `lane_submit` / `lane_resolve`; optional, and refused
 * as missing only when {@link leftoverSignal} finds the lane declares itself one part of several.
 * Absent reads as none.
 */
export const LaneFollowsUpSchema = z.union([
  z.literal('none'),
  z.array(z.string().min(1)).min(1).max(20),
]);
export type LaneFollowsUp = z.infer<typeof LaneFollowsUpSchema>;

/**
 * ADR 561: the issue a lane came from (`acme/app#12`, `ENG-42`) — the key `musterd import` re-sync
 * matches on. One lane that is neither done nor abandoned per ref per team; the store refuses a second.
 */
export const LaneSourceRefSchema = z
  .string()
  .min(1)
  .max(200)
  // Printed on terminals and handed to models: no C0/C1 control characters (escape injection).
  // eslint-disable-next-line no-control-regex -- the control characters ARE the subject here
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, 'source_ref may not contain control characters');

/** ADR 487 §5.4: how long a Goal's live lanes may all sit untouched before `team_next` says so. */
export const GOAL_STALE_DAYS = 7;

/** ADR 487 §5.2 bounds: a snapshot is a list of titles, not the transcript. */
export const LANE_TODOS_MAX_ITEMS = 20;
export const LANE_TODO_MAX_CHARS = 140;

/**
 * What the seat's session left unfinished when its turn last ended (ADR 487 §5.2) — the to-do
 * tool's own titles, last write wins, written by the harness hook onto the seat's most recently
 * updated live lane. Advisory, never an assignment; `at` dates it for the weekly sweep.
 */
export const LaneTodosSchema = z.object({
  items: z.array(z.string().min(1).max(LANE_TODO_MAX_CHARS)).min(1).max(LANE_TODOS_MAX_ITEMS),
  at: z.number().int(),
});
export type LaneTodos = z.infer<typeof LaneTodosSchema>;

/**
 * S2 (ADR 487 §5.1): a lane whose title or detail declares a part — `N of M`, `N/M`, `increment N`,
 * `phase N`, or an increment id like `1A` — has a tail somewhere, so its close must say where.
 * S1 joins them: a lane carrying an unfinished to-do snapshot (`unfinished_todos`, ADR 487 §5.2)
 * has work its session never finished. Returns the matched text (for the refusal) or null.
 *
 * Deliberately broad: a false positive costs one `follows_up: "none"`; a miss costs the plan.
 */
const PART_SIGNALS: readonly RegExp[] = [
  // `N of M` is a part only when nothing but punctuation, the end, or a part noun follows it, and never
  // inside a grouped number. 2026-10-13 (lane 01M4VY3DQ2): "3 of 4 red PRs" is a count, and
  // "1,127 of 1,232 rows" matched as "127 of 1" because `\b` falls at the comma in a digit group.
  /(?<![\d,.])\b\d+\s+of\s+\d+(?![,.]?\d)(?=\s*(?:$|[^\w\s]|(?:parts?|increments?|phases?|steps?|lanes?)\b))/i,
  /(?<![\d/.-])\b\d{1,2}\/\d{1,2}\b(?![\d/.-])/,
  /\bincrements?\s+\d+/i,
  /\bphases?\s+\d+/i,
  /\b\d{1,2}[A-H]\b/,
];
export function leftoverSignal(lane: {
  title: string;
  detail: string | null;
  unfinished_todos?: LaneTodos | null | undefined;
}): string | null {
  const todos = lane.unfinished_todos?.items.length ?? 0;
  if (todos > 0) return `${todos} unfinished to-do${todos === 1 ? '' : 's'}`;
  for (const text of [lane.title, lane.detail ?? '']) {
    for (const re of PART_SIGNALS) {
      const m = re.exec(text);
      if (m) return m[0];
    }
  }
  return null;
}

export const LaneSchema = z.object({
  id: z.string(),
  team: z.string(),
  /** Surface-space scope — contention is checked within a project, never across (ADR 068 workspace). */
  project: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  /**
   * What sort of lane this is. `null` = ordinary work lane; `'incident'` = daemon-opened
   * shared-blocker lane (spec 2026-08-14). Immutable after open on purpose — it is deliberately
   * absent from `UpdateLaneSchema`: an incident that stops being one is resolved, never relabeled.
   * Optional (not defaulted) so pre-v41 fixtures and older daemons stay assignable — consumers only
   * ever ask `kind === 'incident'`, and absence answers that correctly.
   */
  kind: z.enum(['incident']).nullable().optional(),
  /**
   * Owning seat name; null = open/unowned. The two are one fact, not two: `state === 'open'` ⟺
   * `owner_seat === null`, enforced on every transition (`updateLane`) — claiming an open lane
   * moves it to `claimed`, and moving one back to `open` releases it. A lane that names an owner
   * while sitting open would let the board assert that someone holds work nobody is doing.
   */
  owner_seat: z.string().nullable(),
  /** Assignment hint (backend/frontend/…); advisory only in P1. */
  role: z.string().nullable(),
  /** Declared scope, e.g. ["packages/server/src/store/**"] — the paths this lane touches, and the
   *  overlap-check input. Canonical token (ADR 296; was `surface_globs`). */
  scope: z.array(z.string()),
  /**
   * Effective areas for this lane (ADR 582 §3): the declared override when `declared_areas` is set,
   * else derived at read time from `scope` (`deriveLaneAreas`). Defaulted to `[]` so an older
   * daemon's response or a minimal test fixture still parses.
   */
  areas: z.array(z.string()).default([]),
  /**
   * Explicit area override (ADR 582 §3): when set, replaces the areas derived from `scope`.
   * Omitted when the lane uses derived areas.
   */
  declared_areas: z.array(z.string()).optional(),
  /** Lane ids this lane builds on. The unmet-dependency-check input. */
  depends_on: z.array(z.string()),
  /** The git branch/artifact carrying the work — what `lane_handoff` transfers. */
  branch: z.string().nullable(),
  /** Optional link up to a declared Goal (ADR 084). null = ungrouped; the join is flat, never a tree. */
  goal_id: z.string().nullable(),
  /**
   * Declared risk tags (ADR 169), e.g. ["user-facing", "production", "cost"]. A tag other than
   * `user-facing` requires a human review. `user-facing` alone is a peer review unless the change
   * is declared big or the landed diff is large ({@link humanReviewRequired}, ADR 631). Declared
   * at open/update, never inferred from surfaces. Defaulted so a newer client parses an older
   * daemon's lanes (skew-tolerant, the ADR 148 posture).
   */
  risk: z.array(z.string()).default([]),
  /**
   * Declared **stakes** for acceptance (ADR 234) — how much this change is worth someone's eyes.
   *
   * Deliberately NOT `risk`. `risk` already has a consumer that routes the ask human-first on any
   * tag, and a second consumer with opposite needs on one value is the shared-predicate trap named
   * in ADR 225: "low stakes" cannot be said in `risk` without either colliding with its empty
   * default or accidentally demanding a human. Each consumer states its own need.
   *
   * Declared, never inferred from the surface — the counterpoint ryder insisted on carrying with
   * nick's proposal is that surface complexity predicts review COST, not review VALUE (the two most
   * valuable acceptance reviews of 2026-08-04 were both on docs, and each changed the artifact). So
   * a filetype rule is the wrong knife; the worker declares.
   *
   * Defaults to `normal` on purpose. An opt-IN-to-acceptance design fails silent — forgetting to
   * declare would drop a lane below the line by inaction. Forgetting must cost an ask, never a
   * review.
   *
   * **Increment 1 records this and changes nothing else.** No routing consumes it yet; the flip is
   * gated on what the label measures.
   */
  stakes: LaneStakesSchema.default('normal'),
  /**
   * WHO put that value there (ADR 244) — `declared` when a person or seat said it, `defaulted` when
   * a team policy wrote it at `lane_open`.
   *
   * This exists to protect ADR 234's rollback test, which asks whether **declared** stakes predict
   * the answer rate. Once an admin policy can write `stakes: 'low'`, a single `low` bucket pools two
   * completely different claims — "the worker judged this small" and "policy assumed this class is
   * small" — and the Eval could no longer tell them apart. It would fail silently and permanently,
   * which is the same confound class as the acceptor monoculture except arriving through a feature
   * instead of an accident. So the two are separated at the source, and the Eval splits on it.
   *
   * `declared` is the honest default for everything else, including a lane that declared nothing:
   * ADR 234 §2 already ruled that absence IS the declaration, so an unstated `normal` is the
   * worker's answer, not a policy's. `defaulted` is written ONLY where a policy actually fired.
   */
  stakes_provenance: LaneStakesProvenanceSchema.default('declared'),
  /**
   * The worker's merge attestation, captured at `awaiting_acceptance` (ADR 192 / formerly
   * `ready_for_review`) so the acceptor's close carries the *worker's* claim verbatim into
   * `git.pr_merged`. Null until `lane_submit`; defaulted for older-daemon skew.
   */
  merged: z
    .object({
      pr: z.number().int().optional(),
      sha: z.string().optional(),
      authorized_by: z.string().optional(),
      /**
       * Seat-side verification tier stamped by `lane_submit` (merge-verified submit):
       * `ancestor` (SHA reachable from origin/main — landed), `unknown_object` (SHA not in the
       * submitting worktree's repo — cross-repo lane), `fetch_failed` (could not refresh
       * origin/main — abstained), `unattested` (no SHA given). `not_ancestor` never appears
       * here: it is refused at submit, before any lane mutation. A z.string rather than an
       * enum so a newer client's tier parses instead of rejecting; consumers compare against
       * {@link MERGE_VERIFICATION_TIERS} and say nothing on values they don't know.
       */
      verification: z.string().optional(),
      /**
       * ADR 612: what kind of landing this is, derived by the submitting seat from the squash
       * commit's paths (`classifyChange`). Absent from a pre-612 seat and from a cross-repo lane.
       * A z.string for the same skew reason as `verification`; compare against
       * {@link CHANGE_CLASSES}. A label only — nothing routes on it (ADR 612 §3).
       */
      change_class: z.string().max(32).optional(),
      /** ADR 612: docs / tests / code file counts beside the class — never the path list. */
      changed: ChangedCountsSchema.optional(),
    })
    .nullable()
    .default(null),
  state: LaneStateSchema,
  /** Present iff `state === 'parked'` (ADR 466). Optional (like `kind`) so older daemons and fixtures stay assignable; absent reads as not parked. */
  parked: LaneParkSchema.nullable().optional(),
  /** ADR 624: the latest decline (a release with a reason), shown by the lane picker. Optional like
   *  `parked`, so older daemons and fixtures stay assignable; absent reads as none. */
  declined: LaneDeclinedSchema.nullable().optional(),
  /**
   * ADR 487: what the close said is left — `"none"` or the lanes carrying the rest. Optional and
   * nullable (like `parked`): absent or null reads as none, so older daemons stay assignable.
   */
  follows_up: LaneFollowsUpSchema.nullable().optional(),
  /** ADR 487: why the lane was dropped (≤ 280), set on or after the move to `abandoned`. */
  abandon_reason: z.string().nullable().optional(),
  /** ADR 561: the issue this lane came from. Absent reads as none (skew posture, like `follows_up`). */
  // Read side stays a plain string: a stored value the write rule would refuse must not break a board.
  source_ref: z.string().nullable().optional(),
  /** ADR 487 §5.2: the seat session's unfinished to-dos, last write wins. Absent reads as none. */
  unfinished_todos: LaneTodosSchema.nullable().optional(),
  /** ADR 585: the claims filed at submit and re-checked at accept, each with its verdict and the
   *  seat whose clone checked it. Absent on lanes submitted before the rail (skew posture). */
  claims: LaneClaimsSchema.optional(),
  /**
   * Board-projection annotation (ADR 169/191), never stored: for a `done` lane, whether the close
   * was a counterpart *acceptance* (derived from the `lane.closed` audit row's closer vs
   * owner-at-close). Wire name stays `verified`; UI copy is accepted / unconfirmed (ADR 192).
   * Absent on non-terminal lanes, on older daemons, and on lanes closed before the audit existed —
   * absent means "unknown", and the UI says nothing rather than guessing.
   */
  verified: z.boolean().optional(),
  /**
   * Board-projection annotation (ADR 283), never stored: for a `done` lane, WHY it closed the way
   * it did — read from the same `lane.closed` audit row `verified` is derived from.
   *
   * `verified: false` is two opposite situations wearing one word, and the response to each is the
   * response the other one would waste. `review_timeout` / `review_unanswered` / `review_cut_short`
   * mean a counterpart was asked and did not answer — go find a person. `no_candidate` /
   * `human_review_missed` mean no ask was ever sent because the roster held nobody eligible — a
   * degradation nobody is at fault for, answered by looking at who is on the team. Measured
   * 2026-08-19 over 344 closes, both halves are populous (40 + 9 against 23 + 16 + 2) and neither
   * reached a reader.
   *
   * Absent means unknown, exactly as `verified` does: a close predating the reason, a lane that
   * never closed, an older daemon, or a value this build does not recognise. A consumer that
   * defaults the absent case to any particular reason re-creates the defect this field fixes.
   */
  close_reason: CloseReasonSchema.optional(),
  /**
   * Board-projection annotation (ADR 518), never stored: for a lane awaiting acceptance, the seat
   * holding its open `lane_review` ask — newest, unanswered, unresolved, not superseded by a
   * re-route. Absent when nobody holds one, on other states, and on older daemons.
   */
  acceptance_reviewer: z.string().optional(),
  /**
   * Board-projection annotation (ADR 518), never stored: for a lane awaiting acceptance, how its
   * acceptance was routed at submit. Absent means unknown — never default it.
   */
  acceptance_route: AcceptanceRouteSchema.optional(),
  created_by: z.string(),
  created_at: z.number().int(),
  claimed_at: z.number().int().nullable(),
  resolved_at: z.number().int().nullable(),
  updated_at: z.number().int(),
});
export type Lane = z.infer<typeof LaneSchema>;

/**
 * The lane contention + staleness signals. Advisory always — a warning never fails a verb.
 * Phase-1 (ADR 083): `unmet_dependency`, `surface_overlap`. Increment 3 (ADR 111 / ADR 088 §5) adds the
 * two staleness signals the interrupt line can't catch: `stale_plan` (the lane's own Goal moved epoch
 * since it was claimed) and `stale_dependency` (a lane it builds on had its Goal move). Both are
 * owner-directed, never broadcast — directory-based invalidation over the goal_id join + depends_on edge.
 * goals-front-door design adds `no_goal` — a contending lane on no goal while the team has unshipped
 * goals; advisory, owner-null, never woken.
 */
export const LaneWarningSchema = z.object({
  kind: z.enum([
    'unmet_dependency',
    'surface_overlap',
    'stale_plan',
    'stale_dependency',
    'no_goal',
    /** value-layer design: a lane waiting on acceptance past ACCEPTANCE_STALE_MS — review debt
     *  made visible. Advisory like `no_goal`: owner null, never a directed wake. */
    'stale_acceptance',
  ]),
  /** The lane the acting party touched (staleness: the stale lane itself). */
  subject: z.string(),
  /** The other party: the depended-on/overlapping lane, or — for `stale_plan` — the moved Goal id. */
  with: z.string(),
  /** Who gets the directed wake (contention: the other lane's owner; staleness: the stale lane's owner); null if unowned. */
  owner: z.string().nullable(),
  detail: z.string(),
});
export type LaneWarning = z.infer<typeof LaneWarningSchema>;

/** Body for `POST /teams/:slug/lanes` (lane_open). `claim` self-owns at create (opt-in, ADR 083). */
export const OpenLaneSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  project: z.string().optional(),
  role: z.string().optional(),
  /** The paths this lane touches (ADR 296). */
  scope: z.array(z.string()).optional(),
  /** Explicit area override (ADR 582 §3) — replaces the areas derived from `scope`. */
  areas: z.array(z.string().min(1).max(32)).max(16).optional(),
  depends_on: z.array(z.string()).optional(),
  branch: z.string().optional(),
  /** Link this lane to a Goal at open (ADR 084) — the id `musterd next` groups + derives status by. */
  goal_id: z.string().optional(),
  /** The issue this lane came from (ADR 561); refused with 409 while another open lane holds it. */
  source_ref: LaneSourceRefSchema.optional(),
  /** Declared risk tags (ADR 169). Which of them ask a human is {@link humanReviewRequired} (ADR 631). */
  risk: z.array(z.string()).optional(),
  /** Declared acceptance stakes (ADR 234). Omitted ⇒ `normal`. `high` on a user-facing lane asks a human (ADR 631). */
  stakes: LaneStakesSchema.optional(),
  /** Lane kind (spec 2026-08-14): only the daemon sets 'incident'; omitted ⇒ ordinary lane. */
  kind: z.enum(['incident']).optional(),
  claim: z.boolean().optional(),
});
export type OpenLane = z.infer<typeof OpenLaneSchema>;

/** Body for `PATCH /teams/:slug/lanes/:id` (lane_update / claim / handoff / resolve — one seam). */
export const UpdateLaneSchema = z.object({
  state: LaneStateSchema.optional(),
  /**
   * Correct the title (ADR 240). Same reasoning as `project` below, applied to the field a reader
   * sees FIRST: a lane opened with a title that misstates the work had no way back, and the only
   * available correction was a note inside the detail — which reaches nobody who decides, from the
   * board, not to open the lane. Forward-only: notification bodies already sent keep the title they
   * were sent with, because they are history. `min(1)` — an empty title is worse than a wrong one.
   */
  title: z.string().min(1).optional(),
  detail: z.string().optional(),
  /**
   * Re-scope this lane's surface-space. `project` is stamped at open from the opener's workspace, so
   * a lane opened from the wrong checkout (or before derivation existed) had no way back — and an
   * immutable field with no escape hatch makes a mis-stamp permanent.
   */
  project: z.string().optional(),
  /** Re-declare the paths this lane touches (ADR 296). */
  scope: z.array(z.string()).optional(),
  /** Set or clear (with `null` or `[]`) the explicit area override (ADR 582 §3). */
  areas: z.array(z.string().min(1).max(32)).max(16).nullable().optional(),
  depends_on: z.array(z.string()).optional(),
  branch: z.string().optional(),
  /** Re-link (or clear, with null) this lane's Goal (ADR 084). */
  goal_id: z.string().nullable().optional(),
  /** Set the issue this lane came from (ADR 561); refused with 409 while another open lane holds it. */
  source_ref: LaneSourceRefSchema.optional(),
  /** Transfer ownership to this seat (lane_handoff / lane_claim sets it to the caller). */
  owner_seat: z.string().optional(),
  /**
   * Why this handoff (ADR 243) — carried into the body of the `handoff` act the transfer already
   * emits, never stored on the lane. `lane_handoff` had no way to say anything, so explaining a
   * handoff took a SECOND act, and that act named no lane and had to derive one from the lanes the
   * sender still held — which is precisely the set the transfer just removed the right answer from.
   * The note exists so the explanation and the correct lane travel in one act instead of two.
   *
   * Meaningful only alongside an `owner_seat` that moves the lane to someone else; ignored
   * otherwise rather than rejected, so a client that always sends it is not punished for it.
   */
  handoff_note: z.string().max(4000).optional(),
  /** Declared risk tags (ADR 169). Which of them ask a human is {@link humanReviewRequired} (ADR 631). */
  risk: z.array(z.string()).optional(),
  /**
   * Re-declare acceptance stakes (ADR 234). Editable after open on purpose: what a change is worth
   * someone's eyes is often only clear once the work exists, and a declaration you cannot revise is
   * one people learn to set defensively.
   */
  stakes: LaneStakesSchema.optional(),
  /**
   * Merge attestation (ADR 109), meaningful on a terminal move of a branch-carrying lane — or, under
   * two-stage close (ADR 192), captured at `awaiting_acceptance` (the worker's claim) and persisted
   * on the lane so a counterpart's later accept carries it. Attested, never verified — recorded to
   * the audit log as `git.pr_merged`.
   */
  merged: z
    .object({
      pr: z.number().int().optional(),
      sha: z.string().optional(),
      authorized_by: z.string().optional(),
      /** Seat-side verification tier — see the field's doc on {@link LaneSchema}. */
      verification: z.string().optional(),
      /** ADR 612 change class — see the field's doc on {@link LaneSchema}. */
      change_class: z.string().max(32).optional(),
      changed: ChangedCountsSchema.optional(),
    })
    // `null` CLEARS a standing attestation (ADR 305 amendment 2, lane 01M2GR0434). The store always
    // honoured it; the wire refused it, so a lane that acquired a wrong stamp — delta's, closed
    // from the VM with stanley's PR — kept it with no remedy. Owner or admin only; the transport
    // refuses a counterpart's clear, the way ADR 305 refuses a counterpart's replace.
    .nullable()
    .optional(),
  /**
   * Route this lane's acceptance ask to a NAMED seat instead of the daemon's pick — meaningful only
   * on the move into `awaiting_acceptance`, ignored elsewhere.
   *
   * The daemon's picker exists to prove diversity, and it is the right default. But an acceptance a
   * human routes by hand had no door at all: the acceptor got told about the lane out of band, sent
   * a real `accept`, and it bound to nothing — `applyAcceptanceVerdict` binds only to a
   * server-composed `lane_review` ask, deliberately. The lane sat in `awaiting_acceptance` until the
   * owner self-closed, and the ledger recorded `verified: false` for work that HAD been reviewed by
   * a second seat (measured 2026-09-01, lane `01M1F9QVG6XCFQAZSH7XSZ13JT`, acceptor `ghost`).
   *
   * So the routing gets a door, and the door is labelled: a named acceptance records
   * `route: 'named'`, never a pick route. Recording it as a pick would assert a diversity guarantee
   * the picker never made — the same corruption `laneClose.ts` refuses for daemon sweeps, running
   * the other way. Whether the named seat is a good acceptor is the namer's judgement; the ledger's
   * job is only to say that a human made it.
   */
  acceptor: z.string().min(1).optional(),
  /**
   * Why this lane is being parked (ADR 466) — required on the move into `parked` (the transport
   * refuses a park without one) and ignored on any other patch. Stored as `parked.reason`.
   */
  park_reason: z.string().min(1).max(280).optional(),
  /** Advisory revisit date (ms) for a park — shown, never acted on. Ignored off the park move. */
  park_until: z.number().int().optional(),
  /**
   * ADR 487 §5.1: what is left after this lane — `"none"` or the lane ids carrying the rest. Rides
   * a submit or a close; required only when the lane declares itself one part of several. Each
   * named lane must exist; one with no goal is attached to this lane's goal.
   */
  follows_up: LaneFollowsUpSchema.optional(),
  /** ADR 585: claims the sender checked in its own clone. The daemon stamps `checked_by` from the
   *  authenticated sender and MERGES into the lane's standing claims (a seat's fresh reading of a
   *  kind+ref replaces its own earlier one; other seats' readings stay). */
  claims: LaneClaimsSchema.optional(),
  /**
   * ADR 487: why this lane is dropped — on the move into `abandoned`, or later on an abandoned lane.
   * Mirrors `park_reason`. Required on an abandoned lane named in another lane's `follows_up`.
   */
  abandon_reason: z.string().min(1).max(280).optional(),
  /** ADR 624: a lane-picker pick — meaningful only on a patch that sets `owner_seat`; recorded on
   *  `lane.claimed`. */
  pick: PickSchema.optional(),
  /** ADR 624: why the seat is giving the lane back — only on a release to `open`; becomes
   *  `declined` on the lane. */
  release_reason: z.string().min(1).max(500).optional(),
  /**
   * ADR 487 §5.2: replace the lane's unfinished to-do snapshot with these titles (the harness hook
   * sends the whole list, last write wins); an empty list clears it. The daemon stamps `at`.
   */
  unfinished_todos: z
    .array(z.string().min(1).max(LANE_TODO_MAX_CHARS))
    .max(LANE_TODOS_MAX_ITEMS)
    .optional(),
});
export type UpdateLane = z.infer<typeof UpdateLaneSchema>;

/**
 * The verification tiers a submit can persist (merge-verified submit). `not_ancestor` is
 * deliberately not a member: it is a refusal outcome at `lane_submit`, never a stored state.
 */
// `MERGE_VERIFICATION_TIERS` lives in `lanes.wire.js`; re-exported below.

/**
 * Every mutating lane verb returns the lane plus any contention warnings (ADR 083 §4). Under
 * two-stage close (ADR 192) a patch that enters `awaiting_acceptance` additionally reports the
 * acceptor routing: who the ask went to, or that self-close is sanctioned (no eligible acceptor live).
 */
export const LaneResultSchema = z.object({
  lane: LaneSchema,
  warnings: z.array(LaneWarningSchema),
  review: z
    .object({
      reviewer: z.string().optional(),
      /** `named` is a seat the submitter routed to by hand (`acceptor`), not one the picker chose —
       *  kept distinct so no reader mistakes a hand-routed acceptance for a proven-diverse one. */
      route: z.enum(['human_admin', 'cross_family', 'named']).optional(),
      self_close_sanctioned: z.boolean().optional(),
      /**
       * ADR 404: why the picker asked nobody. Present only on a no-ask submit (fresh or standing).
       * Absent on older daemons — clients keep the historical "no eligible acceptor is live" line.
       */
      empty_pool: EmptyPoolSchema.optional(),
      /**
       * The lane was ALREADY awaiting acceptance: this is a report of the standing state (who was
       * asked at the original submit), not a fresh routing decision. Set on repeat submits — e.g.
       * recording the merge SHA after the PR lands, which is the normal flow. Consumers must never
       * read a standing report's missing reviewer as "no eligible acceptor is live": that misread
       * sanctioned self-close against lanes whose acceptor had a pending ask (2026-08-05), the
       * premature unverified close ADR 235 measured 20-for-20.
       */
      standing: z.boolean().optional(),
      /**
       * Lane 01M1QYHJFY: the lane was already awaiting acceptance and this submit named a DIFFERENT
       * acceptor — a fresh ask was minted to `reviewer` (route `named`) and the standing ask, if
       * any, was closed on the seat named in `superseded`, who was told. Never set beside
       * `standing`: a re-route is a new routing decision, not a report of the old one.
       */
      rerouted: z.boolean().optional(),
      superseded: z.string().optional(),
      /** ADR 234 increment 2: the submit was acceptance-exempt (declared low stakes) — no ask
       *  exists and none is owed; self-close is the designed path, not a degradation. */
      acceptance_exempt: z.boolean().optional(),
      /**
       * ADR 235: this team has an acceptance backstop, so an unanswered lane gets collected rather
       * than hanging — which is what makes "leave it with them" safe advice instead of a way to
       * strand work. Present only when an acceptor was actually asked AND the team armed
       * `loops.sweep`.
       *
       * Absent means "no backstop to rely on", which is also what an older daemon sends — so the
       * fallback is the pre-235 advice, and the degradation is toward the safe answer rather than
       * toward telling a seat to wait for a sweep that will never run.
       */
      backstop: z
        .object({ armed: z.boolean(), grace_ms: z.number().int().nonnegative() })
        .optional(),
      /**
       * ADR 506: how long the acceptor was promised — the team's `acceptance_review_window_ms`
       * floor applied to the ask's tier, read back from the routing row so a standing or re-routed
       * report states the same promise. The owner's "wait ≤Nm" comes from this. Present only when
       * an acceptor was asked; absent on older daemons, where clients fall back to the default.
       */
      wait_ms: z.number().int().positive().optional(),
    })
    .optional(),
  /** Advisory lines appended to this caller's result only (value-layer design: the ship nudge) —
   *  rendered to the actor, never a wake, never stored. */
  notices: z.array(z.string()).optional(),
  /** ADR 505 §6: present when THIS patch was a self-claim of a lane with finished dependencies —
   *  what the claimer is building on (title, outcome, PR, acceptor's note), so the check happens
   *  at the moment it matters. Absent from an older daemon and from every other patch. */
  built_on: z.array(z.lazy(() => BuiltOnSchema)).optional(),
});
export type LaneResult = z.infer<typeof LaneResultSchema>;

/**
 * One finished dependency as the claimer sees it (ADR 505 §6). `note` is the head of the accept
 * that closed it — the acceptor's own words, the first thing to re-check. `verified` is the
 * ADR 169 derivation off the `lane.closed` row (a counterpart confirmed it) — `false` means an
 * unconfirmed close, which is a reason to check harder, not a reason to skip.
 */
export const BuiltOnSchema = z.object({
  lane: z.string(),
  title: z.string(),
  state: LaneStateSchema,
  merged: z.object({ pr: z.number().int().optional(), sha: z.string().optional() }).optional(),
  closed_by: z.string().optional(),
  verified: z.boolean().optional(),
  note: z.string().optional(),
});
export type BuiltOn = z.infer<typeof BuiltOnSchema>;

/** `GET /teams/:slug/lanes` — the board: lanes (optionally filtered) with live warnings annotated. */
export const LaneBoardSchema = z.object({
  lanes: z.array(LaneSchema),
  warnings: z.array(LaneWarningSchema),
});
export type LaneBoard = z.infer<typeof LaneBoardSchema>;

/**
 * One edge of a lane's recorded life (ADR 582 §4): a `lane.*` audit row, reduced to the fields a
 * reviewer reads. Which optional fields are present depends on `action` — `lane.claimed` carries
 * `owner`/`previous_owner`/`kind`, `lane.state_changed` `from`/`to`, `lane.updated` `fields`,
 * `lane.closed` `verified`/`reason`. Unknown actions arrive with `ts`/`action`/`actor` only, so a newer
 * daemon's edge still renders.
 */
export const LaneEventSchema = z.object({
  ts: z.number(),
  action: z.string(),
  actor: z.string().nullable(),
  owner: z.string().nullable().optional(),
  previous_owner: z.string().nullable().optional(),
  kind: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fields: z.array(z.string()).optional(),
  verified: z.boolean().optional(),
  reason: z.string().optional(),
  reviewer: z.string().optional(),
});
export type LaneEvent = z.infer<typeof LaneEventSchema>;

/**
 * `GET /teams/:slug/lanes/:id` — one lane in full (ADR 582 §4): the lane as the board annotates it,
 * its warnings, its recorded history oldest first, and the acceptance ask standing on it, so a
 * reviewer can `reply_to` without a lookup. `acceptance_ask` is null when none is open.
 */
export const LaneDetailSchema = z.object({
  lane: LaneSchema,
  warnings: z.array(LaneWarningSchema),
  history: z.array(LaneEventSchema),
  acceptance_ask: z.object({ id: z.string(), to: z.string() }).nullable(),
});
export type LaneDetail = z.infer<typeof LaneDetailSchema>;

/**
 * `lane_board`'s `q` (ADR 582 §1/§4). Today it takes one lane id, full or a prefix of at least 8
 * characters, and answers with that lane in full; the query grammar (`goal:`, `area:`, bare words)
 * lands with lane 01M4VKRXEX. A `q` that is not a lone id is refused, never read as a search.
 */
export const LaneQuerySchema = z.string().trim().min(1).max(200);

/**
 * A lone lane id: a ULID or a prefix of one, 8 to 26 characters of its alphabet. A ULID's first
 * character is a timestamp digit 0–7, which is what keeps an 8-letter word like `standard` from
 * reading as an id.
 */
export function laneIdQuery(q: string): string | null {
  const t = q.trim().toUpperCase();
  return /^[0-7][0-9A-HJKMNP-TV-Z]{7,25}$/.test(t) ? t : null;
}

/** One history edge as a line: `<when> <who> <what>`. Shared by the CLI and the MCP render. */
export function laneEventLine(e: LaneEvent): string {
  const when = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ');
  const who = e.actor ?? '—';
  const verb = e.action.startsWith('lane.') ? e.action.slice(5) : e.action;
  let what: string;
  switch (e.action) {
    case 'lane.claimed':
      what =
        e.kind === 'handoff'
          ? `handed to ${e.owner ?? '?'} from ${e.previous_owner ?? '?'}`
          : `claimed by ${e.owner ?? '?'}`;
      break;
    case 'lane.state_changed':
      what = `${e.from ?? '?'} → ${e.to ?? '?'}`;
      break;
    case 'lane.updated':
      what = `edited ${(e.fields ?? []).join(', ') || 'fields'}`;
      break;
    case 'lane.released':
      what = `released${e.owner ? ` (was ${e.owner})` : ''}`;
      break;
    case 'lane.ready_for_review':
      what = 'submitted for acceptance';
      break;
    case 'lane.closed':
      what = `closed${e.to ? ` ${e.to}` : ''}${e.verified === false ? ' (unconfirmed)' : e.verified ? ' (confirmed)' : ''}${e.reason ? ` — ${e.reason}` : ''}`;
      break;
    default:
      what = `${verb.replace(/_/g, ' ')}${e.reviewer ? ` (${e.reviewer})` : ''}`;
  }
  return `${when} ${who} ${what}`;
}

/**
 * `GET /teams/:slug/next` — the orientation brief (ADR 049), computed server-side so CLI + MCP render
 * one projection. The derived floor works at zero compliance: it reads the daemon's own lane/act
 * state. (The roadmap-Goal-by-wave enrichment is deferred with the Goal-source seam, ADR 048.)
 */
/**
 * The three numbers the per-turn surfaces need from the brief (lane 01M2GTB0RA, 2026-09-14):
 * the statusline and the orient nudge were calling `GET /next` — the whole brief, 0.5 s on the
 * live db and 1.8 s under load, from nine sessions on every turn and every statusline refresh —
 * and reading `in_flight.length`, `incidents[].lane` and `owed_reviews[].{lane,ts}` out of it.
 * `GET /next/summary` answers those from three bounded queries and nothing else.
 */
export const NextSummarySchema = z.object({
  member: z.string(),
  /** Lanes this seat holds in a live state (`in_flight.length` of the brief). */
  carrying: z.number().int().nonnegative(),
  /** Open incident lane ids, oldest first (`incidents[].lane` of the brief). */
  incidents: z.array(z.string()),
  /** Acceptance asks this seat owes a verdict on (`owed_reviews[].{lane.id, ts}` of the brief). */
  owed: z.array(z.object({ lane: z.string(), ts: z.number().int() })),
  /**
   * Active Team holds (ADR 516, SPEC A.15), soonest end first. Optional with no default: omission
   * means the daemon does not report holds, `[]` means it does and none is active.
   */
  holds: z.array(HoldSchema).optional(),
});
export type NextSummary = z.infer<typeof NextSummarySchema>;

export const NextBriefSchema = z.object({
  /** Whose brief this is. */
  member: z.string(),
  /** Lanes you own that are live (claimed/active/blocked/awaiting_acceptance) — what you're carrying. */
  in_flight: z.array(LaneSchema),
  /** Your most recently shipped lanes (done), newest first — what just landed. */
  shipped: z.array(LaneSchema),
  /**
   * Unowned lanes you could pick up — what to start next. Never parked ones, and never a lane whose
   * `depends_on` is unmet (ADR 536: "could pick up" is literal). Ranked PER MEMBER over the team's
   * pool, in lexicographic tiers (ADR 536 §4.3): the lane a live handoff to you names or the goal it
   * carries › a `role` you hold › the oldest lane of a stalled goal, then any in-flight goal › a
   * `scope` overlapping what you shipped in the last 30 days › the rest; oldest first within a
   * tier. A `role` you do not hold ranks last, never out. A window of at most five —
   * `up_next_total` says how many were claimable.
   */
  up_next: z.array(LaneSchema),
  /**
   * How many open lanes were claimable (no unmet dependency) — `up_next` is a window on them
   * (ADR 536). Same reason `up_next_seeds_total` exists: a window with no total reads as the whole
   * pool. `.default(0)` keeps an older daemon's brief parseable; a renderer prints no count on 0.
   */
  up_next_total: z.number().int().nonnegative().default(0),
  /**
   * How many open lanes were withheld from `up_next` for an unmet `depends_on` (ADR 536). Reported,
   * never hidden: the board still lists them, and a seat deciding what to do should know the
   * backlog is deeper than what it may start.
   */
  up_next_blocked_total: z.number().int().nonnegative().default(0),
  /**
   * Why each offered lane is where it is (ADR 536 increment 2) — one row per `up_next` entry, same
   * order. `tier` is the highest tier that placed it (1–5, §4.3); `reasons` are the fixed strings
   * the server composed for every signal that fired, in tier order, and empty for tier 5. A ranking
   * that cannot be argued with cannot be corrected, so the reason rides with the rank. Never free
   * text from a lane body. `.default([])` keeps an epoch-30 brief parseable.
   */
  up_next_why: z
    .array(
      z.object({
        lane: z.string(),
        tier: z.number().int().min(1).max(5),
        reasons: z.array(z.string()),
      }),
    )
    .default([]),
  /**
   * How many lanes are parked (ADR 466). A count, not the lanes: a parked lane is kept, not
   * offered, so the brief says it exists and where to look (`lane_board`) without inviting pickup.
   */
  parked_total: z.number().int().nonnegative().default(0),
  /**
   * In-flight Goals that have stopped moving (ADR 487 §5.4): every live, unparked lane under the goal
   * has gone {@link GOAL_STALE_DAYS} without an update. One row per goal naming its oldest untouched
   * lane. Advisory and derived — never a wake (ADR 258's posture); a parked lane is a human's
   * "not now" and does not count as stalling.
   */
  stale_goals: z
    .array(
      z.object({
        goal: z.string(),
        lane: z.string(),
        lane_title: z.string(),
        idle_ms: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  /**
   * Recorded intentions nobody has started: open Seeds awaiting exploration, oldest first
   * (ADR 373 increment 4).
   *
   * Here, above `up_next`, because `next` answers "what should I do" and an unowned recorded
   * intention is that same question one step earlier — a Seed is what a Lane has not become yet.
   * Deliberately NOT in `inbox --waiting`, which carries acts addressed to a seat: an intention is
   * addressed to nobody, which is the condition ADR 373 exists to fix, so filing it where a reader
   * looks for their own name would hide it a second time.
   *
   * Compact on purpose — the brief is read on every orientation, so this carries what decides
   * "should I pick this up" and nothing else. `ref` is the source tag: a repo path plus anchor for
   * a document-recorded intention, `null` for a relay capture, whose source is a person.
   * `.default([])` keeps an older daemon's brief parseable.
   */
  up_next_seeds: z
    .array(
      z.object({
        id: z.string(),
        source: z.enum(SEED_SOURCES),
        /** `docs/decisions/354-….md#left-for-a-sibling-lane` for a repo Seed; null for a relay one. */
        ref: z.string().nullable(),
        /** The intention as written — the Seed body's first line, bounded for a one-line render. */
        summary: z.string(),
        submitted_by: z.string(),
        captured_at: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  /**
   * How many Seeds are open in total — `up_next_seeds` shows at most the oldest few. Same reason
   * `review_debt_total` exists: a window with no total reads as the whole tray, so a reader clears
   * what is on offer and never learns how much was behind it.
   */
  up_next_seeds_total: z.number().int().nonnegative().default(0),
  /**
   * Verdicts someone is waiting on from YOU (ADR 233): lanes still in the acceptance stage whose
   * review ask was routed to this seat. Oldest ask first — the longest wait is the one closest to
   * being closed unverified.
   *
   * Here because the ask alone does not survive being busy. Measured over the dogfood ledger: half
   * the unverified self-closes had the named reviewer ONLINE for ~40 minutes across an 18-hour
   * window and still never answering — *more* awake time than the reviewers who did answer
   * (0.67h vs 0.22h). Having time was not the problem; being reminded was. The ask lands once in an
   * inbox that scrolls, and nothing re-surfaces it, so a seat that goes heads-down loses it.
   *
   * Not `in_flight`: those are lanes you OWN. A review is owed on someone else's work, and folding
   * the two would make "what am I carrying" mean two different things.
   */
  owed_reviews: z
    .array(
      z.object({
        /** The lane awaiting your verdict. */
        lane: LaneSchema,
        /** Who is waiting — the lane's owner, as the ask's sender. */
        from: z.string(),
        /** The ask to answer: pass as `reply_to` so the verdict binds to this lane and no other. */
        ask_id: z.string(),
        /** When it was asked, so the reader can see how long someone has been waiting. */
        ts: z.number().int(),
      }),
    )
    .default([]),
  /**
   * ADR 505 §3: review rejections on lanes I own that I have not answered. A reviewer's `decline`
   * the daemon stamped `dispute {via:'review'}` is owed one reply — `accept` (conceded, naming
   * the check) or `decline` (held, naming the evidence) — and like `owed_reviews` it must
   * survive the seat being heads-down: the inbox scrolls, the brief does not. Gone the moment
   * the owner replies on it, or the lane leaves `active`. `.default([])` for an older daemon.
   */
  owed_disputes: z
    .array(
      z.object({
        /** The lane that was sent back — mine, and still `active`. */
        lane: LaneSchema,
        /** Who rejected it. */
        from: z.string(),
        /** The rejection to answer: pass as `reply_to` so the answer binds to this dispute. */
        dispute_id: z.string(),
        /** The rejection note, head only — the reason the lane came back. */
        note: z.string(),
        /** When it was rejected. */
        ts: z.number().int(),
      }),
    )
    .default([]),
  /**
   * ADR 483: this seat's own dispute numbers over the last 5 days — answered, named a check,
   * conceded, held — and only its own. `null` when the seat answered fewer than 5 disputes in the
   * window (nothing to show, not a zero) or sits in the withheld arm of ADR 483 decision 4's A/B;
   * absent when the daemon predates ADR 483. Never a percentage, rank, or another seat's row
   * (ADR 294 §4): the brief is the one place this exists, and it exists for one reader.
   */
  own_disputes: OwnDisputeRowSchema.nullable().optional(),
  /** Accepted typed review requests this Member owns. Absent means the daemon predates ADR 490. */
  request_reviews: z.array(ReviewPromiseOpenRowSchema).optional(),
  /** Accepted typed review requests this Member made. Absent means the daemon predates ADR 490. */
  requested_reviews: z.array(ReviewPromiseOpenRowSchema).optional(),
  /** Non-owner closes still awaiting the owner's inbox cursor, when reported by an ADR 490 daemon. */
  review_closures: z.array(ReviewPromiseClosureRowSchema).optional(),
  /** The latest `handoff` act to you or @team — the human-authored *why*, enrichment when present. */
  why: z
    .object({
      from: z.string(),
      body: z.string(),
      ts: z.number().int(),
      goal_id: z.string().nullable(),
      /** ADR 522: the handoff's claims checked against the Team now. Absent when there are none. */
      checks: z.array(ClaimCheckSchema).optional(),
    })
    .nullable(),
  /**
   * The next Goal to pick up (ADR 049/084): the first `planned` declared Goal by `wave`, skipping any
   * still blocked by an unshipped `depends_on`. `null` when nothing is declared (the seam is opt-in —
   * musterd's own dogfood uses `roadmap.data.ts` instead, so this is null there) or nothing qualifies.
   */
  next_goal: GoalSchema.nullable(),
  /**
   * goals-front-door design: the team's unshipped Goals, wave-ordered (`in-flight` before `planned`
   * at equal wave) — the brief leads with the missions, not the lane pool. `.default([])` keeps a
   * brief from an older daemon parseable.
   */
  goals: z.array(GoalSchema).default([]),
  /**
   * value-layer design: the team's oldest lanes waiting on acceptance (cap 3, oldest first) —
   * review debt surfaced as candidate work for ANY seat, not just the routed acceptor
   * (`owed_reviews` is the directed slice; this is the ambient one). Absent when nothing waits.
   */
  review_debt: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        owner: z.string().nullable(),
        waited_ms: z.number().int().nonnegative(),
        /**
         * True when the submit found NO eligible reviewer and asked nobody. ADR 188/253 refuse to
         * route `same_model` and ungradeable seats, so on a same-model monoculture every candidate
         * is refused and the lane enters the queue unrouted. Without this the entry is
         * indistinguishable from one whose named reviewer is merely slow — and the two want
         * opposite responses: chase a person, or notice that no person exists.
         * `.default(false)` keeps a brief from an older daemon parseable.
         */
        no_candidate: z.boolean().default(false),
        /** ADR 404: why nobody was asked, when `no_candidate` is true. */
        empty_pool: EmptyPoolSchema.optional(),
        /**
         * True when the lane's merge attestation carries no SHA — under merge-verified
         * submit nothing has landed, so there is NOTHING TO ACCEPT YET: the wait is on the
         * author's merge button, not a reviewer (dolly's #961/#963, 2026-08-21). Only
         * grandfathered lanes and older clients can reach this state; new submits are
         * refused unlanded. `.default(false)` keeps older-daemon briefs parseable.
         */
        unlanded: z.boolean().default(false),
        /**
         * ADR 539: the peer stage is done and the human stage has not been asked — a risky lane
         * whose newest `lane.review_peer_confirmed` row fired no human ask and that no
         * `lane.review_human_asked` row followed. The wait is on a human coming live, not on a
         * reviewer being slow, and the two want different responses. `.default(false)` keeps an
         * older daemon's brief parseable.
         */
        pending_human: z.boolean().default(false),
        /** ADR 539: who gave the peer confirmation, when `pending_human` is true. */
        peer_confirmed_by: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * How many lanes are waiting on acceptance in total — `review_debt` shows at most the oldest 3.
   * A window with no total reads as the whole queue: clear the three on offer, look again, and more
   * appear with nothing having said they were there. `.default(0)` keeps an older daemon's brief
   * parseable, and 0 with a non-empty `review_debt` means "this daemon does not count".
   */
  review_debt_total: z.number().int().nonnegative().default(0),
  /**
   * Incident convergence inc 1 (spec 2026-08-14 §4): open `kind:'incident'` lanes, oldest first.
   * The brief LEADS with these — most of the measured waste was seats starting sessions into a red
   * they assumed was theirs. `.default([])` keeps a brief from an older daemon parseable.
   */
  incidents: z
    .array(
      z.object({
        /** The incident lane id — claim it or park behind it. */
        lane: z.string(),
        /** The clustered gate (the lane title minus the derived prefix). */
        gate: z.string(),
        /** Who carries it; null = unclaimed, any seat may take it. */
        owner_seat: z.string().nullable(),
        /** Lane created_at — lets the renderer say how long it has been open. */
        opened_at: z.number().int(),
        /**
         * When the claim window shuts and the incident falls to `fallback_role` (ADR 271). Null once
         * someone owns it, or when the team disabled convergence — in both cases there is no
         * countdown to state. A seat reading the banner is deciding whether to pick this up, and
         * "unclaimed" alone does not say whether that decision is still theirs to make.
         * `.optional()` so a brief from a pre-ADR-271 daemon still parses.
         */
        claim_closes_at: z.number().int().nullable().optional(),
        /** Who it falls to at that moment. Null when nobody holds the role — an incident that will
         *  stay unowned, which the seat reading this should know before assuming it is handled. */
        fallback_role: z.string().nullable().optional(),
      }),
    )
    .default([]),
  /**
   * Active Team holds (ADR 516, SPEC A.15), soonest end first — what the Team is paused on, by
   * whom, until when. Optional with no default: omission means the daemon does not report holds.
   */
  holds: z.array(HoldSchema).optional(),
});
export type NextBrief = z.infer<typeof NextBriefSchema>;

/**
 * Everything one lane's full read adds below its board line (ADR 582 §4), as lines — the CLI's
 * `lane show` and the MCP `lane_board {q}` both render these, so the two cannot drift. The board
 * line itself and the warnings stay each surface's own (they render those for the board already).
 */
export function laneDetailLines(d: LaneDetail): string[] {
  const l = d.lane;
  const out: string[] = [];
  if (l.detail) out.push(`brief: ${l.detail}`);
  const areas = l.areas ?? [];
  if (areas.length > 0) {
    out.push(
      `areas: ${areas.join(', ')}${l.declared_areas && l.declared_areas.length > 0 ? ' (declared)' : ''}`,
    );
  }
  if (l.merged) {
    const m = l.merged;
    const parts = [
      m.pr !== undefined ? `#${m.pr}` : null,
      m.sha ? m.sha.slice(0, 10) : null,
      m.verification ?? null,
      m.authorized_by ? `authorized by ${m.authorized_by}` : null,
    ].filter((p): p is string => p !== null);
    out.push(`merged: ${parts.join(' ') || 'yes'}`);
  }
  if (l.follows_up) {
    out.push(`follows up: ${l.follows_up === 'none' ? 'none' : l.follows_up.join(', ')}`);
  }
  if (l.abandon_reason) out.push(`abandoned: ${l.abandon_reason}`);
  if (d.acceptance_ask) {
    const a = d.acceptance_ask;
    out.push(
      `acceptance ask ${a.id} → ${a.to} — verdict: team_send {act:'accept'|'decline', reply_to:'${a.id}'}`,
    );
  } else if (l.state === 'done' && l.verified !== undefined) {
    out.push(`closed ${l.verified ? 'confirmed' : 'unconfirmed'}`);
  }
  if (d.history.length > 0) {
    out.push('history:');
    for (const e of d.history) out.push(`  ${laneEventLine(e)}`);
  }
  return out;
}
