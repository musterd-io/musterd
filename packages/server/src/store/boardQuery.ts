/**
 * The board query's matching half (ADR 582 §1). The grammar is parsed in `@musterd/protocol`
 * (one definition, read at the boundary); here a parsed query is applied to a row.
 *
 * The rules, in one place:
 * - **Every** term must match. Groups AND; repeats of one key OR (`state:open state:claimed`).
 * - A bare word matches case-insensitively against the title and the detail; a quoted phrase
 *   matches as one run of text.
 * - A keyed term matches its field: `goal`, `area`, `owner`, `state`, `role`, `risk`, `project`
 *   and `path` for lanes; `status` for Goals.
 * - `path:` keeps a lane whose declared surface overlaps the path, through the same
 *   `globsOverlap` the rest of the daemon uses (ADR 582 §1).
 *
 * Matching is in memory over the board the route already read, so a query costs one board read —
 * the same as every other filter on this endpoint.
 */
import {
  type BoardQueryTerm,
  BoardQuerySchema,
  emptyValuedKey,
  type Goal,
  type Lane,
  parseBoardQuery,
  unknownQueryKey,
} from '@musterd/protocol';
import { globsOverlap } from './lanes.js';

/** The keyed terms grouped by key (repeats of one key are OR'd) and the bare words on their own. */
function groupTerms(terms: readonly BoardQueryTerm[]): {
  keyed: Map<string, string[]>;
  bare: BoardQueryTerm[];
} {
  const keyed = new Map<string, string[]>();
  const bare: BoardQueryTerm[] = [];
  for (const t of terms) {
    if (t.key === null) {
      bare.push(t);
      continue;
    }
    const values = keyed.get(t.key) ?? [];
    values.push(t.value);
    keyed.set(t.key, values);
  }
  return { keyed, bare };
}

/** Does the lane's own field carry the value? Equality is case-insensitive; lists match by member. */
function laneFieldMatches(lane: Lane, key: string, value: string): boolean {
  const v = value.toLowerCase();
  switch (key) {
    case 'goal':
      return (lane.goal_id ?? '').toLowerCase() === v;
    case 'area':
      return lane.areas.some((a) => a.toLowerCase() === v);
    case 'owner':
      return (lane.owner_seat ?? '').toLowerCase() === v;
    case 'state':
      return lane.state.toLowerCase() === v;
    case 'role':
      return (lane.role ?? '').toLowerCase() === v;
    case 'risk':
      return lane.risk.some((r) => r.toLowerCase() === v);
    case 'project':
      return lane.project.toLowerCase() === v;
    case 'path':
      // The lane's surface is a list of globs; the query names a path. `globsOverlap` is the
      // daemon's one glob-vs-path rule (ADR 582 §1).
      return lane.scope.some((g) => globsOverlap(g, value));
    default:
      return false;
  }
}

/** Does this lane satisfy the query? Every term must match. */
export function matchLaneQuery(lane: Lane, terms: readonly BoardQueryTerm[]): boolean {
  const { keyed, bare } = groupTerms(terms);
  for (const t of bare) {
    const haystack = `${lane.title}\n${lane.detail ?? ''}`.toLowerCase();
    if (!haystack.includes(t.value.toLowerCase())) return false;
  }
  for (const [key, values] of keyed) {
    if (!values.some((v) => laneFieldMatches(lane, key, v))) return false;
  }
  return true;
}

/** A query read off the wire: the terms, or the one sentence that refuses it. */
export type BoardQueryRead = { ok: true; terms: BoardQueryTerm[] } | { ok: false; message: string };

/**
 * Read a `?q=` off the wire (ADR 582 §1). An unknown key is refused by name — a query must never
 * quietly become a text search the seat did not mean — and a key with no value is refused too.
 */
export function readBoardQuery(raw: string, allowed: readonly string[]): BoardQueryRead {
  const parsed = BoardQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: 'a query is 1-200 characters of text' };
  }
  const terms = parseBoardQuery(parsed.data);
  const unknown = unknownQueryKey(terms, allowed);
  if (unknown !== null) {
    return {
      ok: false,
      message: `unknown query key ${JSON.stringify(unknown)} — want one of: ${allowed.join(', ')}`,
    };
  }
  const empty = emptyValuedKey(terms);
  if (empty !== null) {
    return { ok: false, message: `${empty}: needs a value` };
  }
  return { ok: true, terms };
}

/** Does this Goal satisfy the query? Bare words read the id, the title and the story. */
export function matchGoalQuery(goal: Goal, terms: readonly BoardQueryTerm[]): boolean {
  const { keyed, bare } = groupTerms(terms);
  for (const t of bare) {
    const haystack = `${goal.id}\n${goal.title}\n${goal.story ?? ''}`.toLowerCase();
    if (!haystack.includes(t.value.toLowerCase())) return false;
  }
  for (const [key, values] of keyed) {
    if (key !== 'status') return false;
    if (!values.some((v) => goal.status.toLowerCase() === v.toLowerCase())) return false;
  }
  return true;
}
