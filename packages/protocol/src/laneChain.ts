import { isObservedAttestation, MODEL_UNKNOWN, REVIEW_GRADES } from './model.js';

/**
 * One lane read end to end (ADR 629). Five links, always, in this order. A mark is
 * `verified` when a check produced it, `stated` when a seat or a client said so, and
 * `missing` when the record has no name. Absent is missing — never a default.
 *
 * Zod-free on purpose: `/live` imports this through `@musterd/protocol/wire`.
 */

export const LANE_CHAIN_LINKS = ['asked', 'claimed', 'model', 'accepted', 'authorized'] as const;
export type LaneChainLinkName = (typeof LANE_CHAIN_LINKS)[number];
export type LaneChainMark = 'verified' | 'stated' | 'missing';

/**
 * ADR 670: how independent the accept was of the worker — the ADR 188 spectrum, plus `human`.
 * The daemon writes it on the closing row (`lane.closed.review_grade`); a close from before that
 * field, or a grade this build does not know, carries none.
 */
export const LANE_REVIEW_GRADES = ['human', ...REVIEW_GRADES] as const;
export type LaneReviewGrade = (typeof LANE_REVIEW_GRADES)[number];

export function isLaneReviewGrade(v: unknown): v is LaneReviewGrade {
  return typeof v === 'string' && (LANE_REVIEW_GRADES as readonly string[]).includes(v);
}

export interface LaneChainLink {
  link: LaneChainLinkName;
  /** The name or model on this link. Null when nothing is recorded. */
  value: string | null;
  mark: LaneChainMark;
  /** `accepted` only (ADR 670): the closing row's review grade, when it recorded one. */
  grade?: LaneReviewGrade;
}

/** The lane fields the chain reads. Extra fields are ignored. */
export interface LaneChainLane {
  owner_seat?: string | null | undefined;
  requested?:
    | { by?: string | null | undefined; basis?: string | null | undefined }
    | null
    | undefined;
  merged?: { authorized_by?: string | null | undefined } | null | undefined;
}

/** One `lane.*` history edge, oldest first, with the model columns when the row has them. */
export interface LaneChainEvent {
  action: string;
  actor?: string | null | undefined;
  owner?: string | null | undefined;
  model?: string | null | undefined;
  model_source?: string | null | undefined;
  verified?: boolean | null | undefined;
  review_grade?: string | null | undefined;
}

/** `act`, `seed`, and `self` are checked (ADR 629). Anything else named is the seat's word. */
const CHECKED_BASIS = new Set(['act', 'seed', 'self']);

function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function missing(link: LaneChainLinkName): LaneChainLink {
  return { link, value: null, mark: 'missing' };
}

function asked(lane: LaneChainLane): LaneChainLink {
  const by = named(lane.requested?.by);
  if (!by) return missing('asked');
  const basis = lane.requested?.basis;
  return {
    link: 'asked',
    value: by,
    mark: basis && CHECKED_BASIS.has(basis) ? 'verified' : 'stated',
  };
}

/**
 * The holder is the lane row when it names one. A released lane keeps the latest
 * `lane.claimed` owner (a handoff is that same action). The store wrote the row, so
 * this link is verified or missing — never stated.
 */
function claimed(lane: LaneChainLane, history: readonly LaneChainEvent[]): LaneChainLink {
  const owner = named(lane.owner_seat);
  if (owner) return { link: 'claimed', value: owner, mark: 'verified' };
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i]!;
    if (event.action !== 'lane.claimed') continue;
    const who = named(event.owner) ?? named(event.actor);
    if (who) return { link: 'claimed', value: who, mark: 'verified' };
  }
  return missing('claimed');
}

/**
 * The claimant's model: the newest `lane.*` row by the `claimed` seat that carries a model
 * (ADR 581, ADR 687). Only when the claimant never wrote a row with a model does the newest
 * row by any actor stand in — the acceptor's close is a different seat's model and must not
 * read as the work's. `observed` is a measurement. `environment` and `binding` are
 * declarations, and a model with no source is a declaration too. The sentinel `unknown` is
 * not a model.
 */
function modelLink(claimant: string | null, history: readonly LaneChainEvent[]): LaneChainLink {
  const rowBy = (filter: (event: LaneChainEvent) => boolean): LaneChainLink | null => {
    for (let i = history.length - 1; i >= 0; i--) {
      const event = history[i]!;
      if (!filter(event)) continue;
      const model = named(event.model);
      if (!model || model === MODEL_UNKNOWN) continue;
      return {
        link: 'model',
        value: model,
        mark: isObservedAttestation(event.model_source) ? 'verified' : 'stated',
      };
    }
    return null;
  };
  return (
    (claimant ? rowBy((event) => named(event.actor) === claimant) : null) ??
    rowBy(() => true) ??
    missing('model')
  );
}

/**
 * The newest confirmed close. `verified: true` is a counterpart (ADR 192). A self-close
 * and a close with no name are missing. `authorized_by` is a different link.
 */
function accepted(history: readonly LaneChainEvent[]): LaneChainLink {
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i]!;
    if (event.action !== 'lane.closed' || event.verified !== true) continue;
    const who = named(event.actor);
    if (!who) continue;
    return {
      link: 'accepted',
      value: who,
      mark: 'verified',
      ...(isLaneReviewGrade(event.review_grade) ? { grade: event.review_grade } : {}),
    };
  }
  return missing('accepted');
}

/**
 * `merged.authorized_by` is the client's word (ADR 109). An ancestor SHA checks that
 * the commit landed. It does not check who authorized the merge, so this mark is
 * stated or missing — never verified.
 */
function authorized(lane: LaneChainLane): LaneChainLink {
  const by = named(lane.merged?.authorized_by);
  if (!by) return missing('authorized');
  return { link: 'authorized', value: by, mark: 'stated' };
}

/** Five links, always, in read order. */
export function laneChain(
  lane: LaneChainLane,
  history: readonly LaneChainEvent[] = [],
): LaneChainLink[] {
  const holder = claimed(lane, history);
  return [
    asked(lane),
    holder,
    modelLink(holder.value, history),
    accepted(history),
    authorized(lane),
  ];
}

/** The CLI / MCP block. The link name is padded; the value is not (model ids are long). */
export function laneChainLines(links: readonly LaneChainLink[]): string[] {
  return [
    'chain:',
    ...links.map(
      (link) =>
        `  ${link.link.padEnd(10)} ${link.value ?? '—'}${link.grade ? ` · ${link.grade}` : ''}  ${link.mark}`,
    ),
  ];
}
