import {
  compareGoals,
  GOAL_STALE_DAYS,
  humanReviewRequired,
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  type Lane,
  type NextBrief,
  type NextSummary,
  type ReviewPromiseAuditRow,
  type ReviewPromiseClosureRow,
  type ReviewPromiseOpenRow,
  ReviewPromiseReferenceSchema,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';
import { checkClaims } from './claimCheck.js';
import { handoffNamedLaneIds, handoffNamedLaneOutOfPlay, handoffNamesNoLane } from './delivery.js';
import { listGoals, nextGoal } from './goals.js';
import { listActiveHolds } from './holds.js';
import { incidentPolicy, openIncidents } from './incidents.js';
import { deriveOwnDisputes } from './insights.js';
import {
  acceptanceEnteredAt,
  emptyPoolFromSubmitAudit,
  globsOverlap,
  listLanes,
  readyForReviewHadNoCandidate,
} from './lanes.js';
import { getMemberByName, getMemberByRole } from './members.js';
import {
  annotateClose,
  closeVerdicts,
  peerConfirmedPending,
  supersededAcceptanceAsks,
} from './review.js';
import { parseRoles } from './rows.js';
import { openSeedsForBrief } from './seeds.js';

/**
 * The orientation brief (ADR 049), computed server-side so CLI + MCP render one projection (ADR 084 —
 * never duplicate the derivation per surface). This is the **derived floor**: it reads the daemon's
 * own lane/act state and works at zero agent compliance — no handoff ritual required. The latest
 * `handoff` act only *enriches* the brief with the human-authored *why*; `next_goal` (the ADR 048
 * Goal-source seam, resolved by ADR 084 — see `./goals.js`) enriches it further when a team opts into
 * declared Goals. Neither is required for the floor to work.
 */

/**
 * Owned + live = what you're carrying right now.
 *
 * `awaiting_acceptance` is carried, which `NextBriefSchema` has always documented and this set used
 * to contradict. A lane waiting on an acceptance is in no other bucket either — `up_next` takes only
 * `open` — so leaving it out made it invisible to the one seat still answerable for it, and nothing
 * else times it out (lane `01KZ7D582V`). Submitting is not putting it down.
 */
const LIVE: ReadonlySet<string> = new Set(['claimed', 'active', 'blocked', 'awaiting_acceptance']);

/**
 * How far back to look for a handoff that still describes live work. Bounded on purpose: a team
 * whose last 20 handoffs all closed has no live why, and saying so beats scanning its whole history
 * to prove it.
 */
const WHY_SCAN_DEPTH = 20;

/**
 * How long a handoff that names NO resolvable lane may hold the `why` slot (ADR 264).
 *
 * The #745 predicate retires a handoff when the lane it names leaves play. A handoff that names no
 * lane has nothing to check, so it was served forever — and "forever" is not a corner case here.
 * Measured against the real ledger 2026-08-13: 21 of 22 seats had a bare handoff in the slot, 19 of
 * them the SAME 38-day-old completion notice ("ADR 100 landed — PR #133 … lane resolved") addressed
 * to one seat and broadcast to the team, then served to nearly everyone as their standing why.
 *
 * So the bound is set from evidence, not taste: across the 24 handoffs whose named lane resolved,
 * the subject work closed in a median 0.9d, p95 6.6d, max 12.8d. Fourteen days sits above the whole
 * observed distribution — it can retire nothing that has ever still been live, while retiring every
 * stale line in the ledger today.
 *
 * Age is the LAST resort and the narrowest one: it applies only where no recorded fact exists. A
 * handoff naming a live lane keeps its slot however old (that lane is the fact). And this is the
 * `why` slot alone — wake candidacy keeps ADR 173 abstain-by-showing untouched, because the trade
 * differs: a spurious wake costs money and a dropped one costs work, but a dead instruction in the
 * brief is not abstention, it is misdirection, and it is read every session by every seat.
 */
export const WHY_BARE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * ADR 536 tier 4: how far back a seat's own shipped lanes count as "near what you shipped". Thirty
 * days keeps an old speciality from pinning a seat to one corner of the repo forever; the spec
 * (docs/superpowers/specs/2026-10-06-up-next-relevance-design.md §4.3) fixes the window and
 * increment 3's readout is what would move it.
 */
export const FAMILIARITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** What `rankUpNext` ranks against — every input a declared fact, none inferred (ADR 536 §2). */
export interface UpNextContext {
  /** The asking member's `roles[]` (ADR 227). Empty for the roleless generalist. */
  roles: readonly string[];
  /**
   * The live `why` handoff's lanes and goal — a human pointed here (tier 1) — and who sent it, for
   * the reason string (increment 2; `undefined` when there is no live handoff).
   */
  pointer: { lanes: ReadonlySet<string>; goal: string | null; from?: string };
  /** Derived goal status by goal id (ADR 258); a goal not in the map is unknown and ranks as planned. */
  goalStatus: ReadonlyMap<string, string>;
  /**
   * The lane each `stale_goals` row names — the oldest untouched lane of a stalled goal — with its
   * `idle_ms`, for the reason string.
   */
  staleLanes: ReadonlyMap<string, number>;
  /** `scope` globs of lanes this member shipped inside {@link FAMILIARITY_WINDOW_MS}. */
  shippedScopes: readonly string[];
}

/**
 * ADR 536 §4.3 — the tier a claimable lane lands in for one member. Lower is offered first.
 *
 * Lexicographic, not weighted: a lane in a higher tier outranks every lane in a lower one, and the
 * reason it was offered is a tier name a seat can argue with (increment 2 renders it). Fractions
 * are the within-tier sub-order the spec names — a stalled goal's lane ahead of a merely in-flight
 * one.
 *
 * Two cases the table does not spell out, resolved here:
 * - A human pointer wins even over a role mismatch. Tier 1's rationale (the handoff is the
 *   human-authored why, ADR 049) outranks the mismatch rank-down, which is a derived signal.
 * - A `role` the member does NOT hold ranks the lane last — never out. Roles are aptitude, not
 *   permission (ADR 227), and a lane whose role nobody live holds must still reach somebody.
 */
export function upNextTier(l: Lane, ctx: UpNextContext): number {
  if (ctx.pointer.lanes.has(l.id) || (ctx.pointer.goal !== null && l.goal_id === ctx.pointer.goal))
    return 1;
  if (l.role !== null && !ctx.roles.includes(l.role)) return 5;
  if (l.role !== null) return 2;
  if (ctx.staleLanes.has(l.id)) return 3;
  if (l.goal_id !== null && ctx.goalStatus.get(l.goal_id) === 'in-flight') return 3.5;
  if (l.scope.some((g) => ctx.shippedScopes.some((s) => globsOverlap(g, s)))) return 4;
  return 5;
}

/**
 * ADR 536 increment 2 (spec §5) — every signal that fired for a lane, as the fixed strings the
 * renders print, in tier order. `upNextTier` says where the lane lands; this says why, including
 * the signals below the one that placed it, so a seat reading "role: platform · near what you
 * shipped" sees the whole case. Empty when nothing fired (tier 5), and empty for a role the member
 * does not hold: the rank-down is the absence of a reason, not a reason.
 *
 * Fixed strings on purpose — never a lane's title or a handoff's body. The spec's table is the
 * contract; a renderer appends these verbatim.
 */
export function upNextReasons(l: Lane, ctx: UpNextContext): string[] {
  const out: string[] = [];
  if (ctx.pointer.lanes.has(l.id) || (ctx.pointer.goal !== null && l.goal_id === ctx.pointer.goal))
    out.push(`${ctx.pointer.from ?? 'a human'} pointed here`);
  if (l.role !== null && ctx.roles.includes(l.role)) out.push(`role: ${l.role}`);
  const idle = ctx.staleLanes.get(l.id);
  if (idle !== undefined) out.push(`goal stalled ${Math.floor(idle / 86_400_000)}d`);
  else if (l.goal_id !== null && ctx.goalStatus.get(l.goal_id) === 'in-flight')
    out.push('goal in flight');
  if (l.scope.some((g) => ctx.shippedScopes.some((s) => globsOverlap(g, s))))
    out.push('near what you shipped');
  return out;
}

/**
 * ADR 536 §4.2–4.3 — the `up_next` window and its two totals, from the whole board.
 *
 * The pool is every `open` lane minus those with an unmet `depends_on` — a lane whose dependency is
 * not `done` cannot be picked up, and the field has always been documented as "lanes you could pick
 * up". A dependency that names no lane on the board does not block (the same rule the contention
 * warnings apply: a deleted dependency is not a standing one). Within the pool the order is
 * `upNextTier`, then ADR 256's goal-attached-first (kept as the within-tier rule, so the
 * link-it nudge still has teeth on a team whose lanes are not all attached), then `created_at`
 * ascending so an unloved lane still surfaces inside its tier. Pure: every caller-side read happens
 * in `deriveNext`, so the tiers are unit-testable in isolation.
 */
export function rankUpNext(
  all: readonly Lane[],
  ctx: UpNextContext,
  limit: number,
): Pick<NextBrief, 'up_next' | 'up_next_total' | 'up_next_blocked_total' | 'up_next_why'> {
  const byId = new Map(all.map((l) => [l.id, l]));
  const open = all.filter((l) => l.state === 'open');
  const claimable = open.filter((l) =>
    l.depends_on.every((d) => {
      const dep = byId.get(d);
      return !dep || dep.state === 'done';
    }),
  );
  const ranked = claimable
    .map((l) => ({ l, tier: upNextTier(l, ctx) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.l.goal_id !== null) - Number(a.l.goal_id !== null) ||
        a.l.created_at - b.l.created_at,
    );
  const window = ranked.slice(0, limit);
  return {
    up_next: window.map(({ l }) => l),
    up_next_total: claimable.length,
    up_next_blocked_total: open.length - claimable.length,
    // Increment 2: the wire tier is the integer the spec names (the 3.5 sub-order is an ordering
    // detail, not a tier a seat argues with), plus every reason that fired.
    up_next_why: window.map(({ l, tier }) => ({
      lane: l.id,
      tier: Math.floor(tier),
      reasons: upNextReasons(l, ctx),
    })),
  };
}

/**
 * ADR 536 increment 3 — the window the PRE-ADR-536 rule would have served from the same board:
 * every `open` lane, oldest first, goal-attached first, no dependency exclusion. Written into each
 * `next.offer` row beside the ranked window so `pnpm next:readout` scores the same pickups against
 * both without reconstructing the board at offer time (the spec's "rows carry enough to rebuild
 * it", made literal). Pure, like `rankUpNext`.
 */
export function baselineUpNext(all: readonly Lane[], limit: number): string[] {
  return all
    .filter((l) => l.state === 'open')
    .sort((a, b) => a.created_at - b.created_at)
    .sort((a, b) => Number(b.goal_id !== null) - Number(a.goal_id !== null))
    .slice(0, limit)
    .map((l) => l.id);
}

function parseMeta(meta: string | null): Record<string, unknown> {
  if (meta === null) return {};
  try {
    const parsed: unknown = JSON.parse(meta);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A malformed meta is not a reason to lose the human's words.
    return {};
  }
}

interface OwedRow {
  ask_id: string;
  ts: number;
  from_name: string;
  lane_id: string;
}

interface DisputeRow {
  dispute_id: string;
  ts: number;
  from_name: string;
  lane_id: string | null;
  body: string;
}

interface HandoffRow {
  from_name: string;
  body: string;
  meta: string | null;
  ts: number;
}

/**
 * The brief's three per-turn numbers from three bounded queries (lane 01M2GTB0RA). Must agree with
 * `deriveNext` on the same db — pinned by orientation.test.ts — without listing every lane, reading
 * every close verdict, scanning handoffs, or deriving goals, which is what the brief does and what
 * nine sessions were paying for on every turn.
 */
export async function deriveNextSummary(
  db: Driver,
  teamId: string,
  _teamSlug: string,
  member: string,
): Promise<NextSummary> {
  const carrying = (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM lanes
        WHERE team_id = ? AND owner_seat = ?
          AND state IN ('claimed', 'active', 'blocked', 'awaiting_acceptance', 'ready_for_review')`,
    [teamId, member],
  ))!.n;
  const incidents = (
    await db.all<{ id: string }>(
      `SELECT id FROM lanes WHERE team_id = ? AND kind = 'incident'
          AND state NOT IN ('done', 'abandoned') ORDER BY created_at`,
      [teamId],
    )
  ).map((r) => r.id);
  const owed = await db.all<{ lane: string; ts: number }>(
    `SELECT l.id AS lane, m.ts AS ts
         FROM messages m
         JOIN members mt ON mt.id = m.to_member
         JOIN lanes l ON l.team_id = m.team_id
                     AND l.id = json_extract(m.meta, '$.lane_review.lane')
        WHERE m.team_id = ? AND m.act = 'ask' AND mt.name = ?
          AND l.state IN ('awaiting_acceptance', 'ready_for_review')
          AND (l.owner_seat IS NULL OR l.owner_seat != ?)
          -- Lane 01M2TNWK0K: the same superseded-ask exclusion the brief applies, kept in SQL so
          -- the summary stays one bounded query. Mirrors await supersededAcceptanceAsks() in review.ts.
          AND NOT EXISTS (
            SELECT 1 FROM audit a
             WHERE a.team_id = m.team_id
               AND a.action = 'lane.review_rerouted'
               AND a.target = l.id
               AND json_extract(a.detail, '$.superseded_ask') = m.id)
        ORDER BY m.ts ASC, m.id ASC`,
    [teamId, member, member],
  );
  // ADR 516: the Team's active holds ride every per-turn surface, so a seat sees the rule — with its
  // author and end — for exactly as long as it is in force, and never has to carry a copy of it.
  const holds = await listActiveHolds(db, teamId, Date.now());
  return { member, carrying, incidents, owed, holds };
}

export async function deriveNext(
  db: Driver,
  teamId: string,
  teamSlug: string,
  member: string,
  shippedLimit = 3,
  upNextLimit = 5,
  opts: { now?: number; upNextSeedLimit?: number } = {},
): Promise<NextBrief> {
  const now = opts.now ?? Date.now();
  const all = await listLanes(db, teamId, teamSlug);
  const mine = all.filter((l) => l.owner_seat === member);

  const in_flight = mine.filter((l) => LIVE.has(l.state));
  // ADR 169/192: annotate what just landed with the DERIVED verified-ness of its close, exactly as
  // the `/lanes` endpoint already does (http.ts) — which is why the web board has rendered
  // accepted/unconfirmed chips since ADR 169 while this brief said only `✓`.
  //
  // That asymmetry is the defect: humans saw the distinction on the board and agents did not see it
  // anywhere, and the brief is the one place a seat reads what just landed. Lane 01M016D5GA — 44
  // files joining typecheck, every CI-deciding gate among them — was swept unreviewed at 24h and
  // listed here indistinguishable from a peer-accepted lane.
  //
  // Absent stays absent: a close that recorded no verdict (pre-ADR-169) is left un-annotated rather
  // than defaulted to `false`. "We do not know" and "nobody confirmed it" are different claims.
  //
  // ADR 283 adds the other half of that sentence — WHY an unaccepted close was unaccepted. The two
  // readings of `unconfirmed` send a seat in opposite directions: `review_timeout` means go chase
  // the person who was asked, `no_candidate` means nobody was ever asked and the roster is the
  // thing to look at. Same audit row, same abstain-by-absence rule, one more field.
  const verdicts = await closeVerdicts(db, teamId);
  const shipped = mine
    .filter((l) => l.state === 'done')
    .sort((a, b) => (b.resolved_at ?? b.updated_at) - (a.resolved_at ?? a.updated_at))
    .slice(0, shippedLimit)
    .map((l) => annotateClose(l, verdicts.get(l.id)));
  // `up_next` is derived below, once the `why` handoff and the goals it ranks against are known
  // (ADR 536). ADR 466: parked lanes are kept, not offered — `up_next` takes only `open`, so the
  // brief carries their count and nothing a reader could mistake for an invitation.
  const parked_total = all.filter((l) => l.state === 'parked').length;

  // ADR 373 increment 4: recorded intentions nobody started, above the open lanes. Fewer than the
  // lanes on purpose — the tray held 31 open Seeds the day this shipped, and a brief that leads with
  // 31 of anything is a brief nobody reads to the end. The total rides along so the window does not
  // read as the whole tray.
  const { seeds: up_next_seeds, total: up_next_seeds_total } = await openSeedsForBrief(
    db,
    teamId,
    opts.upNextSeedLimit ?? 3,
  );

  // Owed reviews (ADR 233): lanes still in the acceptance stage whose review ask came to ME.
  //
  // Why the brief and not the inbox: the inbox already carries the ask, and it is not enough. Half
  // the unverified self-closes on this team had the named reviewer ONLINE for ~40 minutes across an
  // 18-hour window and still never answering — more awake time than the reviewers who did answer.
  // The ask arrives once, while the seat is mid-lane, and nothing ever re-surfaces it.
  //
  // "Still in the acceptance stage" IS the unanswered test (ADR 192 as repaired: an accept closes
  // the lane it accepts). So there is no accept-message bookkeeping to drift out of sync with the
  // lane — the lane state is the single source, and a review answered any way at all disappears
  // from here for free.
  const owed_reviews = (
    await Promise.all(
      (
        await db.all<OwedRow>(
          `SELECT m.id AS ask_id, m.ts AS ts, mf.name AS from_name,
              json_extract(m.meta, '$.lane_review.lane') AS lane_id
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'ask'
          AND mt.name = ?
          AND json_extract(m.meta, '$.lane_review.lane') IS NOT NULL
        ORDER BY m.ts ASC, m.id ASC`,
          [teamId, member],
        )
      ).map(async (r) => {
        const lane = all.find((l) => l.id === r.lane_id);
        // Gone, closed, or mine. Never ask a seat to review its own lane: the ask can name you (a
        // self-submitted lane on a one-seat team), but reviewing your own work is the thing the
        // counterpart exists to prevent, so it is not a reminder — it is a wrong instruction.
        if (!lane || !isAwaitingAcceptance(lane.state) || lane.owner_seat === member) return [];
        // Lane 01M2TNWK0K: a re-route leaves TWO ask rows on one lane, and lane state alone cannot
        // say which is standing. The verdict edge and `openAcceptanceAsk` already refuse the
        // superseded one; the brief must too, or the relieved seat's `next` keeps saying "verdict
        // owed" — which is how wanderer and ryder both judged #1541, nine minutes apart.
        if ((await supersededAcceptanceAsks(db, teamId, lane.id)).has(r.ask_id)) return [];
        return [{ lane, from: r.from_name, ask_id: r.ask_id, ts: r.ts }];
      }),
    )
  ).flat();

  // Owed disputes (ADR 505 §3): rejections on MY lanes that I have not answered. The mirror of
  // `owed_reviews` — there the verdict is owed on someone else's work; here the answer is owed on
  // my own. Read off the daemon's stamp (`dispute.via = 'review'`), and "unanswered" is the one
  // thing the stamp cannot say: no accept/decline from me replying to it. A lane that has left
  // `active` (resubmitted, re-routed by a hold, closed) retires the row for free.
  const owed_disputes = (
    await db.all<DisputeRow>(
      `SELECT m.id AS dispute_id, m.ts AS ts, mf.name AS from_name, m.body AS body,
              json_extract(m.meta, '$.dispute.lane') AS lane_id
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'decline'
          AND mt.name = ?
          AND json_extract(m.meta, '$.dispute.via') = 'review'
          AND NOT EXISTS (
            SELECT 1 FROM messages r
             WHERE r.team_id = m.team_id
               AND r.in_reply_to = m.id
               AND r.act IN ('accept', 'decline')
               AND r.from_member = mt.id
          )
        ORDER BY m.ts ASC, m.id ASC`,
      [teamId, member],
    )
  ).flatMap((r) => {
    const lane = mine.find((l) => l.id === r.lane_id);
    if (!lane || lane.state !== 'active') return [];
    const note = r.body.trim();
    return [
      {
        lane,
        from: r.from_name,
        dispute_id: r.dispute_id,
        note: note.length > 200 ? `${note.slice(0, 200)}…` : note,
        ts: r.ts,
      },
    ];
  });

  // The why: the latest handoff addressed to me or the team (not one I sent). Enrichment, never
  // required — but it is read as a live instruction, so a handoff whose named lane has left the
  // recipient's plate is worse than no handoff at all. Walk back from the newest and take the first
  // that is still in play, using the same #745 predicate the wake path uses (`handoffNamedLaneOutOfPlay`):
  // awaiting_acceptance or terminal. A second, narrower copy here (terminal-only) is how this brief
  // kept serving work that was already submitted.
  //
  // Deliberately NOT a `stale` marker on the payload: that forks `NextBriefSchema` for what the
  // brief can answer on its own. Bare / unparseable / missing-lane handoffs stay shown (ADR 173
  // abstain-by-showing; #745 is equally narrow) — but no longer forever: past WHY_BARE_MAX_AGE_MS a
  // handoff naming no resolvable lane gives up the slot (ADR 264), because that is the only case
  // where nothing else can ever retire it. CLI `musterd next` and MCP `team_next` render this
  // projection — they do not re-derive it (ADR 084).
  const rows = await db.all<HandoffRow>(
    `SELECT mf.name AS from_name, m.body AS body, m.meta AS meta, m.ts AS ts
         FROM messages m
         JOIN members mf ON mf.id = m.from_member
         LEFT JOIN members mt ON mt.id = m.to_member
        WHERE m.team_id = ?
          AND m.act = 'handoff'
          AND (mt.name = ? OR m.to_kind IN ('team','broadcast'))
          AND mf.name != ?
        ORDER BY m.ts DESC, m.id DESC
        LIMIT ?`,
    [teamId, member, member, WHY_SCAN_DEPTH],
  );

  // The body is passed as well as the meta: every handoff since ADR 231 (#662) names its lane in
  // meta, but the 24 that predate it never will, and a bare row is always "in play" — so without
  // this the newest bare handoff holds the `why` slot permanently. See
  // `handoffNamedLaneOutOfPlay` for why resolving an id out of prose is a recorded fact and not a
  // guess, and why it is all-or-nothing across every lane the body names.
  let row: (typeof rows)[number] | undefined;
  for (const r of rows) {
    if (
      !(await handoffNamedLaneOutOfPlay(db, teamId, r.meta, r.body)) &&
      !(now - r.ts > WHY_BARE_MAX_AGE_MS && (await handoffNamesNoLane(db, teamId, r.meta, r.body)))
    ) {
      row = r;
      break;
    }
  }

  // ADR 522: the handoff's claims checked against the Team now — the brief quotes a handoff for
  // as long as it is the latest, so its "carry on with X" can outlive X.
  const whyChecks = row ? await checkClaims(db, { id: teamId }, row.body) : [];
  const why = row
    ? {
        from: row.from_name,
        body: row.body,
        ts: row.ts,
        goal_id: (() => {
          const g = parseMeta(row.meta)['goal_id'];
          return typeof g === 'string' ? g : null;
        })(),
        ...(whyChecks.length ? { checks: whyChecks } : {}),
      }
    : null;

  // The Goal-source seam (ADR 048/084): general-team declared Goals, if any exist. musterd's own
  // dogfood uses roadmap.data.ts instead, so this is null there — not every team opts into it.
  const allGoals = await listGoals(db, teamId, teamSlug);
  const next_goal = nextGoal(allGoals);

  // goals-front-door design: the brief leads with the unshipped Goals — the missions frame the lane
  // pool, not the other way around. Ordering is the shared ADR 257 rule (shelved last, `in-flight`
  // before `planned`, then most recently declared first).
  const goals = allGoals.filter((g) => g.status !== 'shipped').sort(compareGoals);
  const stale_goals = staleGoals(goals, all, now);

  // ADR 536 — `up_next`, ranked for THIS member over the TEAM's pool. The pool is every open lane,
  // the same for everyone, so nothing is hidden from the board; the order is the seat's, so two
  // seats orienting in the same minute are not handed the same five. What ranks is declared only
  // (ADR 530's posture): the `why` handoff's lanes and goal, `Lane.role` against `Member.roles`,
  // goal status, `scope` against what this seat shipped. Nothing reads a title, a diff or a model.
  const me = await getMemberByName(db, teamId, member);
  const pointerLanes = row
    ? new Set(await handoffNamedLaneIds(db, teamId, row.meta, row.body))
    : new Set<string>();
  const { up_next, up_next_total, up_next_blocked_total, up_next_why } = rankUpNext(
    all,
    {
      roles: me ? parseRoles(me) : [],
      pointer: {
        lanes: pointerLanes,
        goal: why?.goal_id ?? null,
        ...(why ? { from: why.from } : {}),
      },
      goalStatus: new Map(allGoals.map((g) => [g.id, g.status])),
      staleLanes: new Map(stale_goals.map((s) => [s.lane, s.idle_ms])),
      shippedScopes: mine
        .filter(
          (l) =>
            l.state === 'done' && (l.resolved_at ?? l.updated_at) >= now - FAMILIARITY_WINDOW_MS,
        )
        .flatMap((l) => l.scope),
    },
    upNextLimit,
  );
  // ADR 536 increment 3: record what was offered, so the ranking can be shown wrong. One row per
  // brief read, churn class (ADR 478). A pickup is the existing `lane.claimed` row (kind `claim`);
  // the readout joins the two by actor within an hour. `appendAudit` swallows storage failures —
  // observability never breaks the brief.
  await appendAudit(db, teamId, {
    actor: member,
    action: 'next.offer',
    target: null,
    result: 'allow',
    detail: {
      offered: up_next_why.map((w) => ({ lane: w.lane, tier: w.tier })),
      baseline: baselineUpNext(all, upNextLimit),
      total: up_next_total,
      blocked_total: up_next_blocked_total,
    },
  });

  // value-layer design: the team's oldest lanes waiting on acceptance — review debt as ambient
  // candidate work for ANY seat (owed_reviews stays the directed slice). Cap 3, oldest first.
  // A seat's own lane is never its candidate review work: ADR 192 grades a same-seat close as
  // unconfirmed (`verified` requires closer ≠ owner), so serving it here invites the one
  // acceptance the model refuses to count.
  const waiting = (
    await Promise.all(
      all
        .filter((l) => isAwaitingAcceptance(l.state) && l.owner_seat !== member)
        .map(async (l) => ({ lane: l, entered: await acceptanceEnteredAt(db, teamId, l) })),
    )
  ).sort((a, b) => a.entered - b.entered);
  const review_debt = await Promise.all(
    waiting.slice(0, 3).map(async ({ lane, entered }) => {
      const no_candidate = await readyForReviewHadNoCandidate(db, teamId, lane.id);
      const empty_pool = no_candidate ? await emptyPoolFromSubmitAudit(db, teamId, lane.id) : null;
      // ADR 539: the peer stage is done and no human was ever asked — the wait is on a human coming
      // live, which a reader should be able to tell from a reviewer being slow.
      const pending = humanReviewRequired(lane)
        ? await peerConfirmedPending(db, teamId, lane.id)
        : null;
      return {
        id: lane.id,
        title: lane.title,
        owner: lane.owner_seat,
        waited_ms: Math.max(0, now - entered),
        pending_human: pending !== null,
        ...(pending ? { peer_confirmed_by: pending.peer } : {}),
        // Whether ANYONE was asked. `pickReviewCounterpart` returns null on a same-model monoculture —
        // ADR 188/253 refuse `same_model` and ungradeable seats on purpose — and the submit records
        // `no_candidate: true` and then says nothing more. The lane sits in this list looking exactly
        // like one whose named reviewer is merely slow, and a seat reading the brief cannot tell the
        // difference. Measured 2026-08-15: three of five waiting lanes had never been routed to anyone,
        // all three on an all-claude roster. Reporting it does not change the routing doctrine — it
        // stops the silence from reading as health. ADR 404 adds *why* (empty room vs live-ineligible).
        no_candidate,
        ...(empty_pool ? { empty_pool } : {}),
        // Merge-verified submit: an attestation without a SHA means nothing landed — the wait is
        // on the author's merge, not a reviewer. New submits can't reach this state (refused
        // seat-side); this badge covers grandfathered lanes and older clients.
        unlanded: lane.merged?.sha === undefined,
      };
    }),
  );
  // The TOTAL, not the shown count. A cap with no total is a queue that looks as deep as its
  // window: clear the three on offer and the next three appear, with nothing having said they were
  // there. Same 2026-08-15 session — three cleared, two more surfaced.
  const review_debt_total = waiting.length;

  // Incident convergence inc 1 (spec §4): open incidents lead the brief for EVERY member — the
  // banner is how a seat starting a session learns a shared red is already owned work.
  //
  // ADR 271 adds the claim window to it. "UNCLAIMED" alone tells a seat the lane is free but not
  // whether taking it is still their decision: in ten minutes it stops being an invitation and
  // becomes someone's assignment. The countdown is what makes "any seat may claim — context beats
  // role" actionable rather than merely true.
  const incPolicy = await incidentPolicy(db, teamId);
  const incidents = await Promise.all(
    (await openIncidents(db, teamId, teamSlug)).map(async (l) => ({
      lane: l.id,
      gate: l.title.replace(/^incident: /, ''),
      owner_seat: l.owner_seat,
      opened_at: l.created_at,
      // Owned ⇒ no window left to state; disabled ⇒ nothing will ever route it.
      claim_closes_at:
        l.owner_seat || !incPolicy.enabled ? null : l.created_at + incPolicy.claim_window_ms,
      // Null when NOBODY holds the role: this incident will sit unowned, and a seat deciding whether
      // to take it should know that rather than assume the countdown ends with it handled.
      fallback_role:
        l.owner_seat || !incPolicy.enabled
          ? null
          : (await getMemberByRole(db, teamId, incPolicy.fallback_role))
            ? incPolicy.fallback_role
            : null,
    })),
  );

  // ADR 490: accepted typed review requests, derived from the Act ledger. All three arrays are
  // emitted, empty included — absence is how an older daemon says it does not report them.
  const promises = await deriveReviewPromises(db, teamId);
  const request_reviews = promises.open.filter((p) => p.owner === member);
  const requested_reviews = promises.open.filter((p) => p.requester === member);
  const review_closures = await unreadClosures(
    db,
    promises.closures.filter((c) => c.owner === member),
  );

  // ADR 483: the seat's own dispute row — its own, over 5 days, only at n ≥ 5, only in the shown
  // arm. Here and nowhere team-wide (decision 2); the readout the report carries stays per seat
  // only at n ≥ 5 too, and that one is for the team's reading, not the seat's.
  const own_disputes = await deriveOwnDisputes(db, teamId, teamSlug, member, now);

  return {
    member,
    in_flight,
    shipped,
    up_next,
    up_next_total,
    up_next_blocked_total,
    up_next_why,
    parked_total,
    stale_goals,
    up_next_seeds,
    up_next_seeds_total,
    owed_reviews,
    owed_disputes,
    own_disputes,
    request_reviews,
    requested_reviews,
    review_closures,
    review_debt_total,
    why,
    next_goal,
    goals,
    ...(review_debt.length ? { review_debt } : {}),
    incidents,
    holds: await listActiveHolds(db, teamId, Date.now()),
  };
}

interface ReviewAcceptRow {
  request_id: string;
  requester: string;
  owner: string;
  owner_id: string;
  context: string;
  meta: string | null;
  accepted_at: number;
}

interface ReviewResolveRow {
  request_id: string;
  resolve_id: string;
  closer: string;
  resolved_at: number;
  received_at: number;
}

type OwnedClosure = ReviewPromiseClosureRow & {
  owner: string;
  owner_id: string;
  received_at: number;
};

/**
 * ADR 490 — review promises, derived from the Act ledger alone: a root `request_help` to one Member
 * carrying `meta.review`, that Member's `accept` naming it in `meta.in_reply_to`, and no
 * Team-addressed `resolve` on its thread. No table and no timer; the Acts are the record.
 *
 * Duplicate accepts collapse to the minimum `(ts, id)`, so every replica holding the same Acts picks
 * the same `accepted_at`. A closed promise whose closer was not its owner becomes a closure candidate;
 * {@link unreadClosures} decides, per owner cursor, whether it is still shown.
 */
export async function deriveReviewPromises(
  db: Driver,
  teamId: string,
): Promise<{ open: ReviewPromiseOpenRow[]; closures: OwnedClosure[] }> {
  const accepts = await db.all<ReviewAcceptRow>(
    `SELECT r.id AS request_id, fr.name AS requester, tr.name AS owner, tr.id AS owner_id,
            r.body AS context, r.meta AS meta, a.ts AS accepted_at
       FROM messages r
       JOIN members fr ON fr.id = r.from_member
       JOIN members tr ON tr.id = r.to_member
       JOIN messages a ON a.team_id = r.team_id
                      AND a.act = 'accept'
                      AND a.from_member = r.to_member
                      AND json_extract(a.meta, '$.in_reply_to') = r.id
      WHERE r.team_id = ?
        AND r.act = 'request_help'
        AND r.thread_id IS NULL
        AND r.to_kind = 'member'
        AND json_extract(r.meta, '$.review') IS NOT NULL
      ORDER BY a.ts ASC, a.id ASC`,
    [teamId],
  );
  const resolves = await db.all<ReviewResolveRow>(
    `SELECT m.thread_id AS request_id, m.id AS resolve_id, f.name AS closer,
            m.ts AS resolved_at, m.created_at AS received_at
       FROM messages m
       JOIN members f ON f.id = m.from_member
      WHERE m.team_id = ?
        AND m.act = 'resolve'
        AND m.to_kind IN ('team', 'broadcast')
        AND m.thread_id IS NOT NULL
      ORDER BY m.created_at ASC, m.id ASC`,
    [teamId],
  );
  // The first resolve received closes the thread; later ones change nothing.
  const closedBy = new Map<string, ReviewResolveRow>();
  for (const r of resolves) if (!closedBy.has(r.request_id)) closedBy.set(r.request_id, r);

  const open: ReviewPromiseOpenRow[] = [];
  const closures: OwnedClosure[] = [];
  const seen = new Set<string>();
  for (const a of accepts) {
    // Ordered by (ts, id): the first row per request is the controlling accept.
    if (seen.has(a.request_id)) continue;
    seen.add(a.request_id);
    const meta = parseMeta(a.meta);
    // A folded Act from an older peer never passed this daemon's envelope check — re-parse here.
    const review = ReviewPromiseReferenceSchema.safeParse(meta['review']);
    if (!review.success || meta['eligible'] !== undefined) continue;
    const closed = closedBy.get(a.request_id);
    if (!closed) {
      open.push({
        request_id: a.request_id,
        requester: a.requester,
        owner: a.owner,
        context: a.context,
        review: review.data,
        accepted_at: a.accepted_at,
      });
    } else if (closed.closer !== a.owner) {
      closures.push({
        request_id: a.request_id,
        resolve_id: closed.resolve_id,
        closer: closed.closer,
        resolved_at: closed.resolved_at,
        owner: a.owner,
        owner_id: a.owner_id,
        received_at: closed.received_at,
      });
    }
  }
  open.sort(
    (x, y) =>
      x.accepted_at - y.accepted_at ||
      (x.request_id < y.request_id ? -1 : x.request_id > y.request_id ? 1 : 0),
  );
  return { open, closures };
}

/**
 * ADR 490 — a non-owner close stays in front of the owner until their inbox cursor crosses the
 * `resolve`. Compared on receipt order `(created_at, id)`, the order the cursor walks — never the
 * sender's `ts`, which a skewed clock could place behind a cursor that has not read it.
 */
async function unreadClosures(
  db: Driver,
  closures: readonly OwnedClosure[],
): Promise<ReviewPromiseClosureRow[]> {
  if (closures.length === 0) return [];
  const cursor = await db.get<{ last_read_ts: number; last_read_message_id: string | null }>(
    'SELECT last_read_ts, last_read_message_id FROM inbox_cursors WHERE member_id = ?',
    [closures[0]!.owner_id],
  );
  return closures
    .filter(
      (c) =>
        !cursor ||
        c.received_at > cursor.last_read_ts ||
        (c.received_at === cursor.last_read_ts &&
          (cursor.last_read_message_id === null || c.resolve_id > cursor.last_read_message_id)),
    )
    .sort((x, y) => x.received_at - y.received_at || (x.resolve_id < y.resolve_id ? -1 : 1))
    .map(({ request_id, resolve_id, closer, resolved_at }) => ({
      request_id,
      resolve_id,
      closer,
      resolved_at,
    }));
}

/** ADR 490 — the Team-wide open rows for the weekly audit: ids, names and time, no prose or refs. */
export async function deriveTeamReviewPromises(
  db: Driver,
  teamId: string,
): Promise<ReviewPromiseAuditRow[]> {
  return (await deriveReviewPromises(db, teamId)).open.map(
    ({ request_id, requester, owner, accepted_at }) => ({
      request_id,
      requester,
      owner,
      accepted_at,
    }),
  );
}

/**
 * ADR 487 §5.4 — the stale-goal line. An in-flight Goal whose live, unparked lanes have ALL gone
 * {@link GOAL_STALE_DAYS} without an update is a plan that stopped: its next increment exists on the
 * board and nobody has touched it. Named once, with the oldest untouched lane, so the reader knows
 * where to start. A goal with no such lane is not stale — it is shipped, parked, or planned.
 */
export function staleGoals(
  goals: readonly { id: string; status: string }[],
  lanes: readonly Lane[],
  now: number,
): NextBrief['stale_goals'] {
  const cutoff = now - GOAL_STALE_DAYS * 86_400_000;
  const out: NextBrief['stale_goals'] = [];
  for (const g of goals) {
    if (g.status !== 'in-flight') continue;
    const live = lanes.filter(
      (l) => l.goal_id === g.id && !LANE_TERMINAL_STATES.has(l.state) && l.state !== 'parked',
    );
    if (live.length === 0 || live.some((l) => l.updated_at >= cutoff)) continue;
    const oldest = live.reduce((a, l) => (l.updated_at < a.updated_at ? l : a));
    out.push({
      goal: g.id,
      lane: oldest.id,
      lane_title: oldest.title,
      idle_ms: now - oldest.updated_at,
    });
  }
  return out;
}
