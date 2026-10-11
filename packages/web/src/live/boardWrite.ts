// Pure decision logic for the writable board (item 5 / ADR 104) — every rule that decides *what a
// member may do to a lane* lives here, testable without DOM. The route/component layer renders these
// verdicts; the daemon remains the authority (these mirror, never replace, its checks).
import type { Lane, LaneBoard, LaneResult, LaneState, UpdateLane } from '@musterd/protocol';
import { isAwaitingAcceptance } from '@musterd/protocol/wire';

/** A verb the board may offer on a card. `patch` is the exact `PATCH /lanes/:id` body. */
export interface LaneAction {
  kind:
    | 'claim'
    | 'start'
    | 'block'
    | 'unblock'
    | 'handoff'
    | 'ready'
    | 'done'
    | 'confirm'
    | 'sendback'
    | 'abandon'
    | 'unpark';
  patch: UpdateLane;
}

const TERMINAL = new Set<Lane['state']>(['done', 'abandoned']);

/**
 * The verb-legality table. Two rules carry it all: an unowned lane is claimable by any member, and
 * only the owner moves an owned lane — you never touch a teammate's card (hand-off is the owner
 * *giving*, not a peer taking). Handoff's patch is a placeholder; the seat picker fills it via
 * {@link handoffPatch}.
 *
 * The one deliberate exception (ADR 192): a lane in `awaiting_acceptance` offers its verbs to the
 * ACCEPTOR, not the owner — `confirm` (accept → done) and `sendback` (reject → active). The
 * owner keeps only the degradation self-close (recorded unconfirmed) plus abandon, so silence never
 * wedges. The owner's own "done" on a live lane became `ready` — the two-stage entry (submit).
 */
export function laneActions(lane: Lane, me: string | null): LaneAction[] {
  if (!me || TERMINAL.has(lane.state)) return [];
  // ADR 466: a parked lane is not claimable. Unpark is offered; the daemon admits it from a human
  // only, so an agent session's click is refused there with the reason.
  if (lane.state === 'parked') return [{ kind: 'unpark', patch: { state: 'open' } }];
  if (!lane.owner_seat) {
    // The daemon flips open→claimed itself when ownership lands (store/lanes.ts) — owner_seat alone.
    return [{ kind: 'claim', patch: { owner_seat: me } }];
  }
  if (isAwaitingAcceptance(lane.state)) {
    if (lane.owner_seat === me) {
      // The degradation path: the acceptance ask timed out (or nobody was eligible) — self-close,
      // recorded unconfirmed by the daemon. Never a wedge.
      return [
        { kind: 'done', patch: { state: 'done' } },
        { kind: 'abandon', patch: { state: 'abandoned' } },
      ];
    }
    return [
      { kind: 'confirm', patch: { state: 'done' } },
      { kind: 'sendback', patch: { state: 'active' } },
    ];
  }
  if (lane.owner_seat !== me) return [];
  const acts: LaneAction[] = [];
  if (lane.state === 'claimed') acts.push({ kind: 'start', patch: { state: 'active' } });
  if (lane.state === 'active') acts.push({ kind: 'block', patch: { state: 'blocked' } });
  if (lane.state === 'blocked') acts.push({ kind: 'unblock', patch: { state: 'active' } });
  acts.push({ kind: 'handoff', patch: {} });
  acts.push({ kind: 'ready', patch: { state: 'awaiting_acceptance' } });
  acts.push({ kind: 'abandon', patch: { state: 'abandoned' } });
  return acts;
}

/** The handoff verb's real patch, once the seat picker has chosen. */
export function handoffPatch(seat: string): UpdateLane {
  return { owner_seat: seat };
}

/**
 * Who an awaiting-acceptance card waits on (ADR 518), from the daemon's two projection fields: the
 * seat holding the open acceptance ask, else why nobody holds one. Null when the board was not told
 * — absent fields mean unknown, and the card says nothing rather than guess.
 */
export function acceptanceWait(lane: Lane): { reviewer: string } | { note: string } | null {
  if (!isAwaitingAcceptance(lane.state)) return null;
  if (lane.acceptance_reviewer) return { reviewer: lane.acceptance_reviewer };
  switch (lane.acceptance_route) {
    case 'no_candidate':
      return { note: 'no eligible reviewer' };
    case 'acceptance_exempt':
      return { note: 'acceptance-exempt' };
    case 'wake_queued':
      return { note: 'waking a reviewer' };
    default:
      return null;
  }
}

/**
 * Fold a mutation echo into the board optimistically, ahead of the firehose's lane act (the AsksStrip
 * precedent); the next lane-event refetch reconciles with daemon truth. In-place replace keeps card order stable;
 * the echoed lane's warnings are authoritative-fresh, everyone else's are kept as-is.
 */
export function applyLaneEcho(board: LaneBoard, result: LaneResult): LaneBoard {
  const i = board.lanes.findIndex((l) => l.id === result.lane.id);
  const lanes =
    i === -1
      ? [...board.lanes, result.lane]
      : board.lanes.map((l, j) => (j === i ? result.lane : l));
  const warnings = [
    ...board.warnings.filter((w) => w.subject !== result.lane.id),
    ...result.warnings,
  ];
  return { lanes, warnings };
}

/** The filter-chip key for ownerless lanes — a name no seat can hold (seat names are word-shaped). */
export const UNOWNED = '∅';

/**
 * The member filter (polish pass): an empty selection means everyone — the chips are a lens, never a
 * gate. Selection keys are seat names, plus {@link UNOWNED} for the ownerless backlog.
 */
export function filterLanes(lanes: Lane[], owners: ReadonlySet<string>): Lane[] {
  if (owners.size === 0) return lanes;
  return lanes.filter((l) => owners.has(l.owner_seat ?? UNOWNED));
}

/**
 * Column DOM guardrail (perf contract: no unbounded lists) — cap with an "…and K more" remainder.
 *
 * `pin` is the deep link's escape hatch: a lane someone was sent here to look at must be on screen
 * even when it sits past the cap, or the link lands on a board that does not visibly contain it.
 * The cap still holds — the pinned item takes the last shown slot rather than being added to it, so
 * the column never renders more than `cap` cards and `hidden` stays the true remainder.
 */
export function capColumn<T>(
  items: T[],
  cap: number,
  expanded: boolean,
  pin?: (item: T) => boolean,
): { shown: T[]; hidden: number } {
  if (expanded || items.length <= cap) return { shown: items, hidden: 0 };
  const shown = items.slice(0, cap);
  const hidden = items.length - cap;
  if (!pin || cap === 0 || shown.some(pin)) return { shown, hidden };
  const pinned = items.slice(cap).find(pin);
  if (!pinned) return { shown, hidden };
  // Board order is preserved among the kept cards: the pinned one came from below the fold, so it
  // belongs at the bottom of what is shown.
  return { shown: [...shown.slice(0, cap - 1), pinned], hidden };
}

/**
 * Where a scroller must sit to put one item in the middle of it — the deep link's aim, as arithmetic
 * rather than a plea to `scrollIntoView`.
 *
 * The board scrolls both axes in a single container whose content height changes as lanes stream in,
 * and the browser's own "bring this into view" heuristics were measured landing the card above the
 * fold and clipped behind the insight rail. One number per axis, clamped to what the scroller can
 * actually do, is both correct and testable without a browser.
 */
export function centerScroll(
  itemStart: number,
  itemSize: number,
  viewSize: number,
  scrollSize: number,
): number {
  const max = Math.max(0, scrollSize - viewSize);
  return Math.min(max, Math.max(0, itemStart + itemSize / 2 - viewSize / 2));
}

/** The two motion sets the board hands its cards: which moved, and which earned the flourish. */
export interface MovedLanes {
  landed: ReadonlySet<string>;
  flourished: ReadonlySet<string>;
}

/** Nothing moved — the first render, and the shared empty value so identity stays stable. */
export const NO_MOVES: MovedLanes = { landed: new Set(), flourished: new Set() };

/** A lane-id → state snapshot, the input `movedLanes` diffs against. */
export function laneStates(lanes: Lane[]): ReadonlyMap<string, LaneState> {
  return new Map(lanes.map((l) => [l.id, l.state]));
}

/**
 * Which cards changed column since the previous snapshot — `landed` animate in, `flourished` get the
 * warm beat.
 *
 * Pure, and deliberately so: this used to read a ref mid-render, which made the board's motion a
 * function of mutable state the renderer could not see and left it impossible to test. A diff of two
 * snapshots is the same logic with neither problem.
 *
 * The flourish fires on an ACCEPTED close only (ADR 192): a counterpart said the outcome matched.
 * A self-close lands like any other move — no celebration for an unconfirmed close,
 * and no beat at all on merely reaching `awaiting_acceptance`.
 */
export function movedLanes(prev: ReadonlyMap<string, LaneState>, lanes: Lane[]): MovedLanes {
  const landed = new Set<string>();
  const flourished = new Set<string>();
  for (const lane of lanes) {
    const was = prev.get(lane.id);
    if (was === lane.state) continue;
    landed.add(lane.id);
    if (lane.state === 'done' && was !== undefined && lane.verified === true) flourished.add(lane.id);
  }
  return { landed, flourished };
}

/**
 * What a blocked card waits on — read off the lane's own `depends_on` (board readability inc 1).
 *
 * The question nick could not answer from the board on 2026-10-05: for every blocked lane, WHAT or
 * WHO it waits on. `deps` names each dependency still unshipped. `stale` is a block whose
 * dependencies have all shipped, so the block is the thing left to clear. `prose` defers to the
 * lane's detail, and `unknown` is a block that recorded no reason at all, said out loud rather than
 * left as an empty card.
 *
 * A dependency the board cannot see counts as met, mirroring the daemon's `unmet_dependency` rule
 * (`laneWarnings`), so the card and the ⚠ flag never disagree. `board` must be the WHOLE board,
 * not the owner/goal-filtered view, or a filter would fake a stale block.
 */
export type BlockedOn =
  | {
      kind: 'deps';
      deps: Array<{ id: string; title: string; owner: string | null; state: LaneState }>;
    }
  | { kind: 'stale' }
  | { kind: 'prose' }
  | { kind: 'unknown' };

export function blockedOn(lane: Lane, board: ReadonlyMap<string, Lane>): BlockedOn | null {
  if (lane.state !== 'blocked') return null;
  if (lane.depends_on.length > 0) {
    const deps = lane.depends_on.flatMap((id) => {
      const dep = board.get(id);
      return dep && dep.state !== 'done'
        ? [{ id, title: dep.title, owner: dep.owner_seat, state: dep.state }]
        : [];
    });
    return deps.length > 0 ? { kind: 'deps', deps } : { kind: 'stale' };
  }
  return lane.detail?.trim() ? { kind: 'prose' } : { kind: 'unknown' };
}
